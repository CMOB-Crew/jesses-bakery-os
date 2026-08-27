"use server";

// NO revalidatePath in this file. See the long note in app/map/actions.ts for
// the measurement: every page here except the two prototypes is force-dynamic,
// so there is no cached server render to invalidate. All revalidatePath does is
// clear the CLIENT router cache, and the router then re-prefetches all 23
// sidebar links. One Save on /map with eight of them fired 46 requests and drew
// three 503s. Components refresh themselves — local state, a toast, or an
// explicit router.refresh().

import { q as sql } from "@/lib/db";

// Write-back layer, slice 1: persist the per-product overrides Simona sets on the
// store profile. Before this, an adjustment lived only in the browser and reset
// on reload; now it saves to store_product_overrides and survives.
export type OverrideInput = {
  storeId: string;
  productId: string;
  qty: number;
  mode: "perm" | "temp";
  from?: string;  // YYYY-MM-DD, temp only
  to?: string;    // YYYY-MM-DD, temp only
};
export type OverrideResult = { ok: true; readonly?: boolean } | { ok: false; error: string };

// Upsert one override. One row per (store, product), so re-adjusting a line
// replaces its previous override rather than stacking. A temp override with no
// end date behaves like perm on read (never expires) — we still store the mode
// the user chose so the UI shows it back correctly.
export async function setStoreOverride(input: OverrideInput): Promise<OverrideResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    const storeId = (input.storeId ?? "").trim();
    const productId = (input.productId ?? "").trim();
    if (!storeId || !productId) return { ok: false, error: "Missing store or product." };

    const qty = Math.round(Number(input.qty));
    if (!Number.isFinite(qty) || qty < 0) return { ok: false, error: "Quantity must be zero or more." };

    const mode = input.mode === "temp" ? "temp" : "perm";
    const from = mode === "temp" ? (input.from ?? "").trim() || null : null;
    const to = mode === "temp" ? (input.to ?? "").trim() || null : null;

    await sql`
      insert into store_product_overrides
        (store_id, product_id, qty, mode, starts_on, ends_on, updated_at, updated_by)
      values (
        ${storeId}::uuid, ${productId}::uuid, ${qty}::int, ${mode},
        ${from}::date, ${to}::date, now(), 'app'
      )
      on conflict (store_id, product_id) do update set
        qty        = excluded.qty,
        mode       = excluded.mode,
        starts_on  = excluded.starts_on,
        ends_on    = excluded.ends_on,
        updated_at = now(),
        updated_by = excluded.updated_by`;

    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not save the adjustment.";
    return { ok: false, error: msg };
  }
}

// Bulk-apply the suggested fixes from Lost sales in one go (Simona's "overall
// stockout fix" ask). Each fix is a permanent per-(store,product) override, the
// same write as a single Adjust, so they flow into the plan identically. Small N
// (only the flagged sellouts), so a simple loop is fine.
export type BulkFix = { storeId: string; productId: string; qty: number };
export type BulkResult = { ok: true; count: number; readonly?: boolean } | { ok: false; error: string };

export async function applyStockoutFixes(fixes: BulkFix[]): Promise<BulkResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, count: (fixes ?? []).length, readonly: true };
  try {
    const clean = (fixes ?? [])
      .map((f) => ({ storeId: (f.storeId ?? "").trim(), productId: (f.productId ?? "").trim(), qty: Math.round(Number(f.qty)) }))
      .filter((f) => f.storeId && f.productId && Number.isFinite(f.qty) && f.qty >= 0);
    if (!clean.length) return { ok: false, error: "No valid fixes to apply." };

    for (const f of clean) {
      await sql`
        insert into store_product_overrides
          (store_id, product_id, qty, mode, starts_on, ends_on, updated_at, updated_by)
        values (${f.storeId}::uuid, ${f.productId}::uuid, ${f.qty}::int, 'perm', null, null, now(), 'app')
        on conflict (store_id, product_id) do update set
          qty        = excluded.qty,
          mode       = excluded.mode,
          starts_on  = excluded.starts_on,
          ends_on    = excluded.ends_on,
          updated_at = now(),
          updated_by = excluded.updated_by`;
    }

    return { ok: true, count: clean.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not apply the fixes." };
  }
}

// Remove an override — the line reverts to the engine's recommended order.
export async function clearStoreOverride(storeId: string, productId: string): Promise<OverrideResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    const sid = (storeId ?? "").trim();
    const pid = (productId ?? "").trim();
    if (!sid || !pid) return { ok: false, error: "Missing store or product." };

    await sql`
      delete from store_product_overrides
      where store_id = ${sid}::uuid and product_id = ${pid}::uuid`;

    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not remove the adjustment.";
    return { ok: false, error: msg };
  }
}

// Write-back slice 2: persist product ranging (in/out) for a store (migration
// 015). Upsert one row per (store, product); absence of a row means ranged by
// default, so we only store explicit choices.
export async function setStoreRanging(storeId: string, productId: string, ranged: boolean): Promise<OverrideResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    const sid = (storeId ?? "").trim();
    const pid = (productId ?? "").trim();
    if (!sid || !pid) return { ok: false, error: "Missing store or product." };
    await sql`
      insert into store_product_ranging (store_id, product_id, ranged, updated_at, updated_by)
      values (${sid}::uuid, ${pid}::uuid, ${ranged}, now(), 'app')
      on conflict (store_id, product_id) do update set
        ranged = excluded.ranged, updated_at = now(), updated_by = excluded.updated_by`;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save ranging." };
  }
}

// Persist the store's "last visited" date (migration 019). Simona keeps this
// current herself; an empty string clears it. Stored on store_settings, so a new
// row leaves service_level null (nullable) and re-saving only touches the date.
export async function setStoreLastVisit(storeId: string, dateStr: string): Promise<OverrideResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    const sid = (storeId ?? "").trim();
    if (!sid) return { ok: false, error: "Missing store." };
    const d = (dateStr ?? "").trim() || null;
    if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) return { ok: false, error: "Use a YYYY-MM-DD date." };
    if (d && d > new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date())) return { ok: false, error: "Visit date can't be in the future." };
    await sql`
      insert into store_settings (store_id, last_visit_on, updated_at, updated_by)
      values (${sid}::uuid, ${d}::date, now(), 'app')
      on conflict (store_id) do update set
        last_visit_on = excluded.last_visit_on, updated_at = now(), updated_by = excluded.updated_by`;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save the visit date." };
  }
}

// Persist the store's profile photo (migration 020). The client resizes the
// image to a small JPEG data URL before calling this, so we just validate the
// shape and cap the size, then store it. An empty string clears the photo.
const MAX_PHOTO_CHARS = 1_400_000; // ~1MB of image after base64 (~33% overhead)
export async function setStorePhoto(storeId: string, dataUrl: string): Promise<OverrideResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    const sid = (storeId ?? "").trim();
    if (!sid) return { ok: false, error: "Missing store." };
    const raw = (dataUrl ?? "").trim();
    const url = raw || null;
    if (url) {
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(url)) return { ok: false, error: "That doesn't look like an image." };
      if (url.length > MAX_PHOTO_CHARS) return { ok: false, error: "Image is too large — try a smaller photo." };
    }
    await sql`
      insert into store_settings (store_id, photo_url, updated_at, updated_by)
      values (${sid}::uuid, ${url}, now(), 'app')
      on conflict (store_id) do update set
        photo_url = excluded.photo_url, updated_at = now(), updated_by = excluded.updated_by`;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save the photo." };
  }
}

// Persist the per-store shelf-cap override (migration 022). `cap` is a hand-set
// override (null clears it, reverting to the size-band default); `noCap` marks a
// pick-to-order store with no fixed limit. Stored on store_settings; a new row
// leaves the other columns at their defaults.
export async function setStoreShelfCap(storeId: string, cap: number | null, noCap: boolean): Promise<OverrideResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    const sid = (storeId ?? "").trim();
    if (!sid) return { ok: false, error: "Missing store." };
    let capVal: number | null = null;
    if (cap != null) {
      const n = Math.round(Number(cap));
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: "Shelf cap must be zero or more." };
      if (n > 100000) return { ok: false, error: "That shelf cap looks too large." };
      capVal = n;
    }
    const nolimit = !!noCap;
    // A no-limit store has no meaningful override number — clear it so the two
    // settings can't contradict each other on read.
    if (nolimit) capVal = null;
    await sql`
      insert into store_settings (store_id, shelf_cap, no_cap, updated_at, updated_by)
      values (${sid}::uuid, ${capVal}::int, ${nolimit}, now(), 'app')
      on conflict (store_id) do update set
        shelf_cap = excluded.shelf_cap, no_cap = excluded.no_cap, updated_at = now(), updated_by = excluded.updated_by`;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save the shelf cap." };
  }
}

// ---------------------------------------------------------------------------
// The delivery week — one save for the whole panel.
//
// Simona, 26 Aug: "One Edit button that opens the whole panel for editing, not
// per-day edit buttons." So this takes all seven days at once and makes the
// database match them, rather than seven little writes that can half-succeed
// and leave a store delivering on Tuesday to nobody.
//
// Two tables carry the answer and they have to agree:
//   stores.delivery_days   — which days this store receives at all
//   store_run_overrides    — the days it rides a run other than its own
//
// A day that names the store's own run is NOT an override. Storing it as one
// would mean the day silently stops moving with the store the next time its
// base run changes, which is exactly the kind of quiet drift that produced
// fourteen hand-kept override rows in the old spreadsheet.
// ---------------------------------------------------------------------------
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type DayPlan = { day: string; on: boolean; runId: string | null };

export async function saveStoreSchedule(storeId: string, plan: DayPlan[]): Promise<OverrideResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    const sid = (storeId ?? "").trim();
    if (!sid) return { ok: false, error: "Missing store." };

    // Normalise to exactly seven days in a fixed order. Anything the client
    // sends that isn't a weekday is dropped rather than trusted.
    const byDay = new Map((plan ?? []).map((p) => [String(p.day ?? "").toLowerCase(), p]));
    const days = WEEKDAYS.map((d) => {
      const p = byDay.get(d);
      return { day: d, on: !!p?.on, runId: (p?.runId ?? null) || null };
    });

    const onDays = days.filter((d) => d.on);

    // The store's own run, as the database has it now.
    const cur = await sql<{ default_run_id: string | null }[]>`
      select default_run_id::text as default_run_id from stores where id = ${sid}::uuid`;
    if (!cur.length) return { ok: false, error: "That store no longer exists." };
    let baseRun = cur[0].default_run_id;

    // Every run id she used must be a real run. A typo'd or stale id would
    // otherwise become a foreign-key error halfway through the write.
    const used = [...new Set(onDays.map((d) => d.runId).filter(Boolean) as string[])];
    if (used.length) {
      const known = await sql<{ id: string }[]>`
        select id::text as id from runs where id::text = any(string_to_array(${used.join(",")}, ','))`;
      if (known.length !== used.length) return { ok: false, error: "One of those runs no longer exists — reload the page and try again." };
    }

    // A store that had no run at all, and now delivers on one run every day it
    // delivers, has just been told what its run is. Adopt it as the base rather
    // than writing the same override seven times. We never CHANGE an existing
    // base run from here — that would move the store on the Delivery Runs board
    // as a side effect of editing days, which she is not asking for.
    if (!baseRun && used.length === 1 && onDays.every((d) => d.runId === used[0])) {
      await sql`update stores set default_run_id = ${used[0]}::uuid where id = ${sid}::uuid`;
      baseRun = used[0];
    }

    // Days that carry a genuine override: delivering, named a run, and that run
    // is not the store's own.
    const overrides = onDays.filter((d) => d.runId && d.runId !== baseRun);
    const keep = overrides.map((d) => d.day).join(",");

    // Delete-what's-gone before insert-what's-new, so the store is never
    // momentarily missing an override it is meant to have.
    await sql`
      delete from store_run_overrides
       where store_id = ${sid}::uuid
         and (${keep} = '' or day::text <> all(string_to_array(${keep}, ',')))`;

    for (const o of overrides) {
      await sql`
        insert into store_run_overrides (store_id, day, run_id)
        values (${sid}::uuid, ${o.day}::weekday, ${o.runId}::uuid)
        on conflict (store_id, day) do update set run_id = excluded.run_id`;
    }

    // delivery_days last: it is the column the plan reads, so if anything above
    // failed we have not yet told the engine to deliver somewhere we cannot.
    // Built through unnest() rather than handed to the driver as an array —
    // weekday is an enum, and a text[] cast per element is the one form that
    // works the same locally and on the pooled Supabase connection.
    const csv = onDays.map((d) => d.day).join(",");
    await sql`
      update stores set delivery_days = (
        select coalesce(array_agg(d::weekday), '{}'::weekday[])
          from unnest(case when ${csv} = '' then '{}'::text[] else string_to_array(${csv}, ',') end) d
      )
      where id = ${sid}::uuid`;

    // NO revalidatePath here — see the long note in app/map/actions.ts. Every
    // page in this app except the two prototypes is force-dynamic, so there is
    // no server render to invalidate; all revalidatePath does is clear the
    // client router cache, which makes it re-prefetch all 23 sidebar links.
    // Measured on /map on 27 Aug: one Save fired 46 requests and drew three
    // 503s. The panel calls router.refresh() instead.
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save the delivery days." };
  }
}

// Write-back slice 2: persist the per-store service-level dial (migration 015).
export async function setStoreServiceLevel(storeId: string, level: string): Promise<OverrideResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    const sid = (storeId ?? "").trim();
    if (!sid) return { ok: false, error: "Missing store." };
    const lvl = ["lean", "balanced", "service"].includes(level) ? level : null;
    if (!lvl) return { ok: false, error: "Invalid service level." };
    await sql`
      insert into store_settings (store_id, service_level, updated_at, updated_by)
      values (${sid}::uuid, ${lvl}, now(), 'app')
      on conflict (store_id) do update set
        service_level = excluded.service_level, updated_at = now(), updated_by = excluded.updated_by`;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save service level." };
  }
}
