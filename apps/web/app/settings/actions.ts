"use server";

import { q as sql, sql as db } from "@/lib/db";
import { revalidatePath } from "next/cache";

// Write-back for the Settings page. Each config group (service level, per-product
// minimums, size baskets, shelf/lead, seasonality factors) saves as one JSONB row
// in app_settings (migration 016). Previously all local-only.
export type WriteResult = { ok: true; readonly?: boolean } | { ok: false; error: string };

const ALLOWED = new Set([
  "service_level",
  "product_minimums",
  "size_baskets",
  "shelf_lead",
  "seasonality_factors",
  "waste_thresholds",
]);

export async function saveSetting(key: string, value: unknown): Promise<WriteResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    const k = (key ?? "").trim();
    if (!ALLOWED.has(k)) return { ok: false, error: "Unknown setting." };
    // Encode the JSONB value with the driver's json helper. The enforced wrapper
    // q() runs the statement, but the value must go through the real client's
    // sql.json() so objects AND arrays (size_baskets) serialise as a jsonb
    // object/array. The old `${JSON.stringify(value)}::jsonb` form stored the
    // value as a jsonb *string* (scalar), so key lookups came back null and the
    // page always fell back to defaults.
    await sql`
      insert into app_settings (key, value, updated_at, updated_by)
      values (${k}, ${db.json((value ?? null) as Parameters<typeof db.json>[0])}, now(), 'app')
      on conflict (key) do update set
        value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`;
    revalidatePath("/settings");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save the setting." };
  }
}
