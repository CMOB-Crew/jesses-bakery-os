"use server";

import { q as sql } from "@/lib/db";
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
]);

export async function saveSetting(key: string, value: unknown): Promise<WriteResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    const k = (key ?? "").trim();
    if (!ALLOWED.has(k)) return { ok: false, error: "Unknown setting." };
    // q() (the enforced wrapper) is a plain tagged template, so pass JSON text
    // and cast to jsonb rather than sql.json().
    const json = JSON.stringify(value ?? null);
    await sql`
      insert into app_settings (key, value, updated_at, updated_by)
      values (${k}, ${json}::jsonb, now(), 'app')
      on conflict (key) do update set
        value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`;
    revalidatePath("/settings");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save the setting." };
  }
}
