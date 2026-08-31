"use server";

// NO revalidatePath in this file. See the long note in app/map/actions.ts for
// the measurement: every page here except the two prototypes is force-dynamic,
// so there is no cached server render to invalidate. All revalidatePath does is
// clear the CLIENT router cache, and the router then re-prefetches all 23
// sidebar links. One Save on /map with eight of them fired 46 requests and drew
// three 503s. Components refresh themselves — local state, a toast, or an
// explicit router.refresh().

import { q as sql, sql as db } from "@/lib/db";
import { getDisplayUser } from "@/lib/supabase/server";

// Persist the approval set for a run board (production / deliveries) for today
// (migration 017), so Simona's ticks survive a reload. The individual nudges
// stay ephemeral; only the approved set is saved, and it's replaced wholesale
// on each change (small map, keeps it simple and consistent for bulk approves).
export type WriteResult = { ok: true; readonly?: boolean } | { ok: false; error: string };

const SURFACES = new Set(["production", "deliveries"]);

// One writer for every surface. Both rules below were learned the hard way and
// neither should ever exist in two copies:
//
//   db.json(payload), not JSON.stringify(payload)::jsonb -- the second form
//   stores a jsonb STRING, the reload reads back a scalar, and every tick is
//   lost. See the note in setRunState, which is where that was found.
//
//   day = null means "the Sydney day", which is what production and deliveries
//   want and is deliberately not current_date. Packing passes an explicit day,
//   because its sheet is routinely a future date.
// payload is typed as whatever db.json() takes, read off the driver's own
// signature rather than guessing at its exported type name. `unknown` was
// rejected outright: TS2345, not assignable to JSONValue.
type JsonPayload = Parameters<typeof db.json>[0];

async function writeRunState(surface: string, day: string | null, payload: JsonPayload, by: string) {
  await sql`
    insert into daily_run_state (surface, day, approved, updated_at, updated_by)
    values (${surface},
            coalesce(${day}::date, (now() at time zone 'Australia/Sydney')::date),
            ${db.json(payload)}, now(), ${by})
    on conflict (surface, day) do update set
      approved = excluded.approved, updated_at = now(), updated_by = excluded.updated_by`;
}

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
    // THE DAY IS THE SYDNEY DAY, not current_date.
    //
    // Postgres current_date resolves in the session timezone, which is UTC on
    // Supabase, and the UTC date does not roll over until 10am Sydney. So an
    // approval ticked at 7am was filed under YESTERDAY, and at 10am the read
    // (queries.ts, getRunState) started looking for today's row, found none,
    // and every tick vanished off the board mid-morning.
    //
    // Which is the exact failure migration 017 was written to prevent: "so
    // working through a run and reloading no longer wipes her progress."
    //
    // The bakery works mornings. This is the window it works in.
    await writeRunState(surface, null, clean, "app");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save approvals." };
  }
}

// Packing ticks for one day. Same table, same writer, different shape and an
// explicit day -- see writeRunState above for both reasons.
//
// The whole map is replaced on every change, exactly as the approval set is.
// It is a few dozen small entries at most, and a wholesale replace is what
// makes "untick" work without needing a delete path.
export type PackStateWrite = Record<string, { s: "packed" | "flagged"; c?: string }>;

export async function setPackingState(day: string, state: PackStateWrite): Promise<WriteResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, readonly: true };
  try {
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(day)) return { ok: false, error: "Bad day." };
    // Only the two real states survive, and the comment is capped. A packer
    // types the reason freehand; there is no reason for it to be unbounded.
    // Both keys always present. An optional property is `string | undefined`,
    // and undefined is not JSON, so `{ c?: string }` is not assignable to what
    // db.json takes. A packed store simply carries an empty comment -- one
    // shape in the database rather than two.
    //
    // The INPUT type still allows c to be absent, because the client sends a
    // packed entry without one. Only what is stored is normalised.
    const clean: Record<string, { s: string; c: string }> = {};
    for (const [k, v] of Object.entries(state ?? {})) {
      if (!v) continue;
      if (v.s === "packed") clean[k] = { s: "packed", c: "" };
      else if (v.s === "flagged") clean[k] = { s: "flagged", c: String(v.c ?? "").slice(0, 300) };
    }
    // Stamped with whoever is signed in, not "app". The page promises "every
    // action stamped to the packer" and updated_by is the column that carries
    // it. Read on the server rather than taken from the client, because a
    // client-supplied name is whatever the client says it is.
    const who = await getDisplayUser().catch(() => null);
    await writeRunState("packing", day, clean, who?.email ?? "app");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save the sheet." };
  }
}
