"use server";

// NO revalidatePath in this file. See the long note in app/map/actions.ts for
// the measurement: every page here except the two prototypes is force-dynamic,
// so there is no cached server render to invalidate. All revalidatePath does is
// clear the CLIENT router cache, and the router then re-prefetches all 23
// sidebar links. One Save on /map with eight of them fired 46 requests and drew
// three 503s. Components refresh themselves — local state, a toast, or an
// explicit router.refresh().

import { q as sql } from "@/lib/db";

// Retailer ids used by the New store form -> the DB retailer_type enum.
const RETAILER_MAP: Record<string, string> = {
  woolworths: "woolworths", coles: "coles", harris_farm: "harris_farm", direct: "invoice",
};
const SIZES = new Set(["small", "medium", "large", "xlarge"]);

export type CreateStoreInput = {
  name: string;
  retailer: string;      // form id (woolworths | coles | harris_farm | direct)
  runId: string;         // the delivery run this store goes out on
  days: string[];        // mon..sun — THIS store's delivery days
  storeNo?: string;      // supplier / location code
  size: string;          // small | medium | large | xlarge
  cap?: number;          // shelf_max
  timing: "upcoming" | "live";
  goLiveDate?: string;   // YYYY-MM-DD (planned go-live when upcoming; actual when live)
  service?: string;      // lean | balanced | generous (form) -> store_settings.service_level
};
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type CreateStoreResult = { ok: true; id: string } | { ok: false; error: string };

// Create a store from the New store form. "upcoming" seeds it inactive with a
// planned go-live (go_live_at) so it lands in Launches > Coming up; "live" marks
// it active with an onboarded_at so it lands in Launches > Live now. This is the
// no-SQL path for adding a rollout.
export async function createStore(input: CreateStoreInput): Promise<CreateStoreResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, id: "demo" };
  try {
    const name = (input.name ?? "").trim();
    if (!name) return { ok: false, error: "Store name is required." };

    const retailer = RETAILER_MAP[input.retailer];
    if (!retailer) return { ok: false, error: "Pick a retailer." };

    const size = SIZES.has(input.size) ? input.size : "small";
    const cap = Number.isFinite(input.cap) && (input.cap as number) > 0 ? Math.round(input.cap as number) : null;
    const storeNo = (input.storeNo ?? "").trim() || null;
    const live = input.timing === "live";
    const date = (input.goLiveDate ?? "").trim() || null; // null date + live => defaults to today in SQL

    if (!live && !date) return { ok: false, error: "Set a planned go-live date, or choose 'Go live now'." };

    // THE BUG THIS FIXES, and it is not a small one.
    //
    // This form has always collected a run and a set of delivery days, shown
    // them back in the summary, and then written NEITHER. The insert set
    // region_id by fuzzy-matching a label and stopped. So every store created
    // here landed with no default_run_id and no delivery_days — which means it
    // appears on no delivery run, and the forecast engine skips it entirely,
    // because the engine scopes on stores.delivery_days (migration 026).
    //
    // A store created through the wizard was invisible to the plan. Migration
    // 043 backfilled a run onto every store that already existed, so this only
    // bites on the NEXT store created — and Simona has around thirty landing.
    //
    // She also spotted this herself on the 26 Aug call at [21:38], a store with
    // "no runs set", and nobody chased where it came from. This is where.
    const runId = (input.runId ?? "").trim();
    if (!runId) return { ok: false, error: "Pick a delivery run — a store with no run goes out on no van." };

    const run = await sql<{ id: string; region_id: string }[]>`
      select id::text as id, region_id::text as region_id from runs where id = ${runId}::uuid`;
    if (!run.length) return { ok: false, error: "That delivery run no longer exists — reload and try again." };

    const days = WEEKDAYS.filter((d) => (input.days ?? []).map((x) => String(x).toLowerCase()).includes(d));
    if (!days.length) return { ok: false, error: "Pick at least one delivery day." };
    const daysCsv = days.join(",");

    const rows = await sql<{ id: string }[]>`
      insert into stores
        (name, retailer, region_id, default_run_id, delivery_days, supplier_code,
         size_category, shelf_max, active, go_live_at, onboarded_at)
      values (
        ${name},
        ${retailer}::retailer_type,
        ${run[0].region_id}::uuid,
        ${run[0].id}::uuid,
        (select coalesce(array_agg(d::weekday), '{}'::weekday[])
           from unnest(string_to_array(${daysCsv}, ',')) d),
        ${storeNo},
        ${size}::store_size,
        ${cap},
        ${live},
        (case when ${live} then null else ${date}::date end),
        (case when ${live} then coalesce(${date}::date, (now() at time zone 'Australia/Sydney')::date) else null end)
      )
      returning id::text as id`;

    // Persist the chosen service level so it's set on the store's profile from
    // day one. The form's "generous" maps to the profile's "service" level
    // (store_settings, migration 015). Non-fatal: a store still gets created if
    // this write fails.
    const svc = input.service === "lean" ? "lean" : input.service === "balanced" ? "balanced" : input.service === "generous" || input.service === "service" ? "service" : null;
    if (svc) {
      try {
        await sql`
          insert into store_settings (store_id, service_level, updated_at, updated_by)
          values (${rows[0].id}::uuid, ${svc}, now(), 'app')
          on conflict (store_id) do update set service_level = excluded.service_level, updated_at = now(), updated_by = excluded.updated_by`;
      } catch { /* store is created regardless; service level is best-effort */ }
    }

    return { ok: true, id: rows[0].id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not create the store.";
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// Create a delivery run. Item 6 of the 26 Aug brief.
//
// [§10] "Delivery Run has to be created before the store if the store belongs
// to a new run. So Setup needs a create-new-run option."
//
// [06:10] is the live case: Simona has ~30 new stores landing and is creating a
// brand new run called City 2, moving stores off the over-full South East run
// and pulling East Village off Hills. She cannot do any of that without this.
//
// WHY THIS WRITES TWO TABLES. Simona uses ONE word, Delivery Run. The schema
// has two: `regions` (the grouping) and `runs` (the van and its days), with
// runs.region_id NOT NULL. Migration 043 established the invariant that every
// region has exactly one named run with days, and everything — the runs board,
// the store panel, the overrides — depends on it. So creating a run creates
// both halves, and the UI keeps showing one thing.
// ---------------------------------------------------------------------------
export type CreateRunResult = { ok: true; id: string; name: string } | { ok: false; error: string };

export async function createRun(name: string, days: string[]): Promise<CreateRunResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, id: "demo", name: (name ?? "").trim() };
  try {
    const nm = (name ?? "").trim();
    if (!nm) return { ok: false, error: "Give the run a name." };
    if (nm.length > 60) return { ok: false, error: "That name is too long." };

    const picked = WEEKDAYS.filter((d) => (days ?? []).map((x) => String(x).toLowerCase()).includes(d));
    if (!picked.length) return { ok: false, error: "Pick at least one day this run goes out." };

    // Case-insensitive, because "City 2" and "CITY 2" being two different runs
    // is how you end up with the mess migration 043 had to clean up.
    const clash = await sql<{ name: string }[]>`
      select name from regions where upper(name) = upper(${nm}) limit 1`;
    if (clash.length) return { ok: false, error: `There is already a run called ${clash[0].name}.` };

    const reg = await sql<{ id: string }[]>`
      insert into regions (name) values (${nm.toUpperCase()}) returning id::text as id`;

    const csv = picked.join(",");
    const run = await sql<{ id: string; name: string }[]>`
      insert into runs (region_id, name, run_days)
      values (
        ${reg[0].id}::uuid,
        ${nm},
        (select coalesce(array_agg(d::weekday), '{}'::weekday[])
           from unnest(string_to_array(${csv}, ',')) d)
      )
      returning id::text as id, name`;

    return { ok: true, id: run[0].id, name: run[0].name };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not create the run." };
  }
}
