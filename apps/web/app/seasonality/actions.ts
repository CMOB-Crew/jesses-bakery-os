"use server";

import { q as sql } from "@/lib/db";
import { revalidatePath } from "next/cache";

// Write-back for the seasonality calendar: persist uplift nudges and let Simona
// add her own events (holidays, school breaks, local events) to the shared
// `events` table the forecast reads. Previously both were local-only.
export type WriteResult = { ok: true; readonly?: boolean } | { ok: false; error: string };

const isUuid = (s: string) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s);

// Persist an event's uplift %. Only applies to real (saved) events — a seed-only
// event that isn't in the table yet has a slug id, not a uuid.
export async function setEventUplift(eventId: string, uplift: number): Promise<WriteResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    const id = (eventId ?? "").trim();
    if (!isUuid(id)) return { ok: false, error: "This is a seed event — add it to save changes." };
    const up = Math.round(Number(uplift));
    if (!Number.isFinite(up)) return { ok: false, error: "Uplift must be a number." };
    await sql`update events set uplift_pct = ${up} where id = ${id}::uuid`;
    revalidatePath("/seasonality");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save the uplift." };
  }
}

export type NewEventInput = { name: string; start: string; end: string; uplift: number; scope?: string };

// Add a custom event to the shared calendar.
export async function addSeasonalEvent(input: NewEventInput): Promise<WriteResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    const name = (input.name ?? "").trim();
    const start = (input.start ?? "").trim();
    const end = (input.end ?? "").trim();
    if (!name) return { ok: false, error: "Give the event a name." };
    if (!start || !end) return { ok: false, error: "Set a start and end date." };
    if (end < start) return { ok: false, error: "End date is before the start date." };
    const up = Math.round(Number(input.uplift)) || 0;
    const scope = (input.scope ?? "").trim() || null;
    await sql`
      insert into events (name, kind, ui_kind, start_date, end_date, uplift_pct, scope)
      values (${name}, 'custom', 'custom', ${start}::date, ${end}::date, ${up}, ${scope})`;
    revalidatePath("/seasonality");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not add the event." };
  }
}
