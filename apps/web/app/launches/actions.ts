"use server";

// NO revalidatePath in this file. See the long note in app/map/actions.ts for
// the measurement: every page here except the two prototypes is force-dynamic,
// so there is no cached server render to invalidate. All revalidatePath does is
// clear the CLIENT router cache, and the router then re-prefetches all 23
// sidebar links. One Save on /map with eight of them fired 46 requests and drew
// three 503s. Components refresh themselves — local state, a toast, or an
// explicit router.refresh().

import { q as sql } from "@/lib/db";

export type LaunchActionResult = { ok: true } | { ok: false; error: string };

const isUuid = (s: string) => /^[0-9a-fA-F-]{36}$/.test(s);

// Flip an upcoming store live: active = true, onboarded_at = the go-live date
// (defaults to today), and clear the planned go_live_at. It moves out of Coming
// up and into Live now for its first 6 weeks. No SQL needed.
export async function markStoreLive(storeId: string, dateStr?: string): Promise<LaunchActionResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true };
  try {
    if (!isUuid(storeId)) return { ok: false, error: "Unknown store." };
    const date = (dateStr ?? "").trim() || null;
    const rows = await sql<{ id: string }[]>`
      update stores
         set active = true,
             onboarded_at = coalesce(${date}::date, (now() at time zone 'Australia/Sydney')::date),
             go_live_at = null
       where id = ${storeId}::uuid
         and active = false
      returning id::text as id`;
    if (!rows.length) return { ok: false, error: "Store is not an upcoming launch." };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not mark the store live." };
  }
}

// Adjust an upcoming store's planned go-live date.
export async function setGoLiveDate(storeId: string, dateStr: string): Promise<LaunchActionResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true };
  try {
    if (!isUuid(storeId)) return { ok: false, error: "Unknown store." };
    const date = (dateStr ?? "").trim();
    if (!date) return { ok: false, error: "Pick a date." };
    const rows = await sql<{ id: string }[]>`
      update stores
         set go_live_at = ${date}::date
       where id = ${storeId}::uuid
         and active = false
         and onboarded_at is null
      returning id::text as id`;
    if (!rows.length) return { ok: false, error: "Store is not an upcoming launch." };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not update the date." };
  }
}
