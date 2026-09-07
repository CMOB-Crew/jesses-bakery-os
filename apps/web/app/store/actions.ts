"use server";

// NO revalidatePath in this file. See the long note in app/map/actions.ts for
// the measurement: every page here except the two prototypes is force-dynamic,
// so there is no cached server render to invalidate. All revalidatePath does is
// clear the CLIENT router cache, and the router then re-prefetches all 23
// sidebar links. One Save on /map with eight of them fired 46 requests and drew
// three 503s. Components refresh themselves — local state, a toast, or an
// explicit router.refresh().

import { q as sql } from "@/lib/db";
// The packing sheet's own weekday-split rule. Imported, never re-implemented:
// setStoreDay seeds a line's untouched days with what they are already being
// packed at, and a second copy of the rule would make "seeding changes nothing"
// false the first time the two drifted.
import { dayShare, dowMultipliers, WD_ORDER } from "@/lib/dayshare";
import { getWeekdayShape } from "@/lib/queries";

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

// ---------------------------------------------------------------------------
// What ONE customer pays for ONE product.
//
// Per store, not per tier. Measured against the 649 real prices carried over
// from the old system: price does not track order size (+0.03 correlation with
// weekly quantity on sourdough across 16 customers) but it does track the
// account -- every C&M branch pays the same on all 16 of its products, every
// Jack & Co on all 22, regardless of branch size.
//
// Writing here marks the row source='manual', which is what stops a re-run of
// the legacy import stamping over a correction somebody made by hand.
// ---------------------------------------------------------------------------
export type PriceInput = { storeId: string; productId: string; price: string | number; xeroCode?: string | null };

export async function setStorePrice(input: PriceInput): Promise<OverrideResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    const storeId = (input.storeId ?? "").trim();
    const productId = (input.productId ?? "").trim();
    if (!storeId || !productId) return { ok: false, error: "Missing store or product." };

    const price = Number(input.price);
    if (!Number.isFinite(price) || price < 0) return { ok: false, error: "Price must be zero or more." };
    // Two decimal places, because this ends up on an invoice. Rounded here
    // rather than trusted from a text input.
    const rounded = Math.round(price * 100) / 100;

    const code = (input.xeroCode ?? "").trim() || null;

    await sql`
      insert into store_product_prices
        (store_id, product_id, unit_price, xero_code, source, updated_at, updated_by)
      values (${storeId}::uuid, ${productId}::uuid, ${rounded}, ${code}, 'manual', now(), 'app')
      on conflict (store_id, product_id) do update set
        unit_price = excluded.unit_price,
        -- A blank code must not wipe a good one that came across in the import.
        xero_code  = coalesce(excluded.xero_code, store_product_prices.xero_code),
        source     = 'manual',
        updated_at = now(),
        updated_by = excluded.updated_by`;

    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not save that price.";
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// The day-by-day standing order.
//
// Simona, 1 Sept: "can you up Wednesday? can you cancel Wednesday's delivery?
// on Friday can you send me nine more bags?" A weekly number cannot say any of
// those things, and cannot say the middle one at all.
//
// Writing ANY day for a line hands that line to the grid: migration 074's rule
// is that the packing sheet then reads only these rows for it. Which is what
// makes a zero mean something -- otherwise "cancel Wednesday" would be refilled
// by last week's carry-forward and do nothing at all.
// ---------------------------------------------------------------------------
const DOW = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
export type DayInput = { storeId: string; productId: string; dow: string; qty: string | number };

export async function setStoreDay(input: DayInput): Promise<OverrideResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    const storeId = (input.storeId ?? "").trim();
    const productId = (input.productId ?? "").trim();
    const dow = String(input.dow ?? "").trim().toLowerCase();
    if (!storeId || !productId) return { ok: false, error: "Missing store or product." };
    if (!DOW.has(dow)) return { ok: false, error: "That is not a day of the week." };

    const qty = Math.round(Number(input.qty));
    // Zero is allowed and is the point: it means "not that day".
    if (!Number.isFinite(qty) || qty < 0) return { ok: false, error: "Quantity must be zero or more." };

    // ---------------------------------------------------------------------
    // SEED THE REST OF THE WEEK, the first time a line joins the grid.
    //
    // Measured 7 September against the packing sheet's own query. A line with
    // no grid rows was carried forward from store_reco and appeared on every
    // one of the store's delivery days. Writing ONE day handed the whole line
    // to the grid -- 074's rule, and the rule that makes a zero mean something
    // -- so the days nobody had typed into went to nothing:
    //
    //   Bagel - Plain, delivered Tue/Wed/Fri, set Tue = 137
    //     Tue  137     Wed  LINE GONE     Fri  LINE GONE
    //
    // Simona's stated reason for wanting this screen is "can you up Wednesday?"
    // -- which is exactly the action that silently cancelled the other two
    // days. The header warned that the grid "replaces the weekly number
    // entirely", but three blank boxes beside one filled box read as untouched,
    // not as zero.
    //
    // So the first write now fills every delivery day with the number that day
    // was ALREADY getting, and the typed day overwrites its own seed below.
    // The share comes from dayShare() -- the same function the packing sheet
    // uses, not a second copy of the rule -- so seeding a line changes nothing
    // about what is packed. Only the day the user typed in moves.
    //
    // Only ever when the line has NO rows at all. A line already on the grid is
    // a complete statement someone made on purpose, and back-filling a day they
    // deliberately left at nothing would put a delivery back on the van.
    // ---------------------------------------------------------------------
    const onGrid = await sql<{ n: number }[]>`
      select count(*)::int as n from store_product_days
       where store_id = ${storeId}::uuid and product_id = ${productId}::uuid`;

    if ((onGrid[0]?.n ?? 0) === 0) {
      // The weekly number this line is on right now, and the days it runs.
      // The override is date-gated the same way the packing sheet gates it, so
      // an expired temp order does not get baked into the seed.
      const ctx = await sql<{ days: string[] | null; weekly: number }[]>`
        select coalesce(s.delivery_days::text[], '{}'::text[]) as days,
               coalesce(o.qty, r.sent, 0)::int                 as weekly
          from stores s
          left join store_reco r
                 on r.store_id = s.id and r.product_id = ${productId}::uuid
          left join store_product_overrides o
                 on o.store_id = s.id and o.product_id = ${productId}::uuid
                and o.qty > 0
                and (o.mode = 'perm' or o.ends_on   is null or o.ends_on   >= current_date)
                and (o.mode = 'perm' or o.starts_on is null or o.starts_on <= current_date)
         where s.id = ${storeId}::uuid`;

      const days = ctx[0]?.days ?? [];
      const weekly = Number(ctx[0]?.weekly ?? 0);

      // No delivery days means we do not know when this store is served, and
      // dayShare returns 0 for every day. Seeding zeros there would invent a
      // decision. No weekly number means there is nothing to carry forward --
      // a line being added from scratch. Either way, write only what was typed.
      if (days.length > 0 && weekly > 0) {
        // Same shape the packing sheet asks for. When there is no measured
        // shape yet both fall back to SEED_DOWMULT, so they still agree. The
        // one case they could differ is a transient failure here that /packing
        // does not hit -- and then the seeded numbers are simply visible in the
        // boxes for Simona to correct, rather than silently applied.
        const mult = dowMultipliers(await getWeekdayShape());
        const seedDows = days.filter((d) => WD_ORDER.includes(d));
        const seedQtys = seedDows.map((d) => dayShare(weekly, days, WD_ORDER.indexOf(d), mult));

        // One statement, and `do nothing` on conflict, so this can never
        // overwrite a day somebody else set between the check above and here.
        // If this succeeds and the write below fails, the line is left holding
        // exactly the numbers it was already being packed at -- a no-op, which
        // is the right way for a half-finished write to fail.
        await sql`
          insert into store_product_days (store_id, product_id, dow, qty, updated_at, updated_by)
          select ${storeId}::uuid, ${productId}::uuid, t.d::weekday, t.q::int, now(), 'app-seed'
            from unnest(${seedDows}::text[], ${seedQtys}::int[]) as t(d, q)
          on conflict (store_id, product_id, dow) do nothing`;
      }
    }

    await sql`
      insert into store_product_days (store_id, product_id, dow, qty, updated_at, updated_by)
      values (${storeId}::uuid, ${productId}::uuid, ${dow}::weekday, ${qty}::int, now(), 'app')
      on conflict (store_id, product_id, dow) do update set
        qty = excluded.qty, updated_at = now(), updated_by = excluded.updated_by`;

    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not save that day.";
    return { ok: false, error: msg };
  }
}

/** Hand the line back to the weekly number. Removing every day row is the only
 *  way out, because a line with any row at all is governed by the grid. */
export async function clearStoreDays(storeId: string, productId: string): Promise<OverrideResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    if (!storeId || !productId) return { ok: false, error: "Missing store or product." };
    await sql`
      delete from store_product_days
       where store_id = ${storeId}::uuid and product_id = ${productId}::uuid`;
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not clear those days.";
    return { ok: false, error: msg };
  }
}
