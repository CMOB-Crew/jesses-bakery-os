"use server";

import { q as sql } from "@/lib/db";
import { revalidatePath } from "next/cache";

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

    revalidatePath(`/store/${storeId}`);
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

    const stores = new Set<string>();
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
      stores.add(f.storeId);
    }

    for (const s of stores) revalidatePath(`/store/${s}`);
    revalidatePath("/lost-sales");
    revalidatePath("/deliveries");
    revalidatePath("/delivery-sheet");
    revalidatePath("/production");
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

    revalidatePath(`/store/${sid}`);
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
    revalidatePath(`/store/${sid}`);
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
    if (d && d > new Date().toISOString().slice(0, 10)) return { ok: false, error: "Visit date can't be in the future." };
    await sql`
      insert into store_settings (store_id, last_visit_on, updated_at, updated_by)
      values (${sid}::uuid, ${d}::date, now(), 'app')
      on conflict (store_id) do update set
        last_visit_on = excluded.last_visit_on, updated_at = now(), updated_by = excluded.updated_by`;
    revalidatePath(`/store/${sid}`);
    revalidatePath("/stores");
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
    revalidatePath(`/store/${sid}`);
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
    revalidatePath(`/store/${sid}`);
    revalidatePath("/stores");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save the shelf cap." };
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
    revalidatePath(`/store/${sid}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save service level." };
  }
}
