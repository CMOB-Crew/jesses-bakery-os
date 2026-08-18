"use server";

import { sql } from "@/lib/db";
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
export type OverrideResult = { ok: true } | { ok: false; error: string };

// Upsert one override. One row per (store, product), so re-adjusting a line
// replaces its previous override rather than stacking. A temp override with no
// end date behaves like perm on read (never expires) — we still store the mode
// the user chose so the UI shows it back correctly.
export async function setStoreOverride(input: OverrideInput): Promise<OverrideResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true };
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

// Remove an override — the line reverts to the engine's recommended order.
export async function clearStoreOverride(storeId: string, productId: string): Promise<OverrideResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true };
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
