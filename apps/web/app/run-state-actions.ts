"use server";

import { q as sql, sql as db } from "@/lib/db";
import { revalidatePath } from "next/cache";

// Persist the approval set for a run board (production / deliveries) for today
// (migration 017), so Simona's ticks survive a reload. The individual nudges
// stay ephemeral; only the approved set is saved, and it's replaced wholesale
// on each change (small map, keeps it simple and consistent for bulk approves).
export type WriteResult = { ok: true; readonly?: boolean } | { ok: false; error: string };

const SURFACES = new Set(["production", "deliveries"]);

export async function setRunState(
  surface: string,
  approved: Record<string, boolean>,
): Promise<WriteResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    if (!SURFACES.has(surface)) return { ok: false, error: "Unknown board." };
    // Drop falsey entries so the stored set stays tidy.
    const clean: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(approved ?? {})) if (v) clean[k] = true;
    // Encode via the driver's sql.json() (through the real client) so `approved`
    // stores as a jsonb object. The old `${JSON.stringify(clean)}::jsonb` form
    // stored it as a jsonb *string*, so reload read back a scalar and the ticks
    // were lost. q() still runs the statement for RLS consistency.
    await sql`
      insert into daily_run_state (surface, day, approved, updated_at, updated_by)
      values (${surface}, current_date, ${db.json(clean)}, now(), 'app')
      on conflict (surface, day) do update set
        approved = excluded.approved, updated_at = now(), updated_by = excluded.updated_by`;
    revalidatePath(surface === "production" ? "/production" : "/deliveries");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save approvals." };
  }
}
