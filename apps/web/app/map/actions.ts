"use server";

import { q as sql } from "@/lib/db";

// ---------------------------------------------------------------------------
// Change the days a delivery run goes out. Item 5 of Simona's 26 Aug brief.
//
// [32:01] "Add a day — her example: adding Thursday to Canberra, taking it to
// three days a week. Change a day for the whole run. On save it must talk to
// production, talk to packing slips, and readjust the forecast."
//
// THE TRAP THIS AVOIDS, stated because it would have been easy to ship:
//
// runs.run_days is read by exactly two things — the New Store wizard's
// "pick a run, days auto-fill", and this screen. The forecast engine does NOT
// read it. It scopes on stores.delivery_days (migration 026, and the reason
// the sourdough plan came down from 5,246 units to 2,547).
//
// So writing only runs.run_days would give her a screen where she adds Thursday
// to Canberra, the card says three days a week, and not one loaf is ever baked
// for it. It would run cleanly and do the wrong thing.
//
// Therefore adding a day to a run adds it to the run AND to the delivery days
// of every active store whose home run this is. Removing a day removes it from
// both. That is what makes the save "talk to production" — production reads the
// plan, the plan reads delivery_days.
//
// WHAT IT DELIBERATELY DOES NOT TOUCH:
//
//   * Visiting stores. A store that rides this run on Saturday as an exception
//     lives on another run; its delivery days belong to that run, not this one.
//   * store_run_overrides. Removing a day that visitors ride is reported back
//     to the caller as a warning rather than silently deleting her exceptions.
//
// Her own workflow, from the call: set the norm at run level, fix anomalies at
// store level one or two days at a time. This is the run level. The store page's
// delivery panel is the other half.
// ---------------------------------------------------------------------------

const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export type RunDaysResult =
  | { ok: true; readonly?: boolean; added: string[]; removed: string[]; storesChanged: number }
  | { ok: false; error: string };

export async function saveRunDays(runId: string, days: string[]): Promise<RunDaysResult> {
  if (process.env.DEMO_READONLY === "1")
    return { ok: true, readonly: true, added: [], removed: [], storesChanged: 0 };
  try {
    const id = (runId ?? "").trim();
    if (!id) return { ok: false, error: "Missing run." };

    const want = WEEKDAYS.filter((d) => (days ?? []).map((x) => String(x).toLowerCase()).includes(d));

    const cur = await sql<{ run_days: string[] | null; name: string }[]>`
      select run_days::text[] as run_days, name from runs where id = ${id}::uuid`;
    if (!cur.length) return { ok: false, error: "That run no longer exists." };
    const have = cur[0].run_days ?? [];

    // A run with no days is not a run. It is the state the twenty legacy
    // "Run N" rows were in, and the reason none of them could be used.
    if (want.length === 0)
      return { ok: false, error: "A run has to go out on at least one day. Move its stores to another run instead of emptying it." };

    const wantSet = new Set<string>(want);
    const haveSet = new Set<string>(have);
    const added: string[] = want.filter((d) => !haveSet.has(d));
    const removed: string[] = have.filter((d) => !wantSet.has(d));
    if (!added.length && !removed.length)
      return { ok: true, added: [], removed: [], storesChanged: 0 };

    // The run's own days first.
    const csv = want.join(",");
    await sql`
      update runs set run_days = (
        select coalesce(array_agg(x::weekday), '{}'::weekday[])
          from unnest(case when ${csv} = '' then '{}'::text[] else string_to_array(${csv}, ',') end) x
      )
      where id = ${id}::uuid`;

    // Then the stores, one day at a time. Enum arrays: appending a single
    // ${d}::weekday is the form that behaves identically on local Postgres and
    // on the pooled Supabase connection — the driver never has to guess a type
    // for an array of enum values.
    const touched = new Set<string>();
    for (const d of added) {
      const rows = await sql<{ id: string }[]>`
        update stores
           set delivery_days = delivery_days || ${d}::weekday
         where default_run_id = ${id}::uuid and active
           and not (${d}::weekday = any(delivery_days))
        returning id::text as id`;
      rows.forEach((r) => touched.add(r.id));
    }
    for (const d of removed) {
      const rows = await sql<{ id: string }[]>`
        update stores
           set delivery_days = array_remove(delivery_days, ${d}::weekday)
         where default_run_id = ${id}::uuid and active
           and ${d}::weekday = any(delivery_days)
        returning id::text as id`;
      rows.forEach((r) => touched.add(r.id));
    }

    // NO revalidatePath. Measured on production, 27 Aug, and it is the opposite
    // of harmless.
    //
    // Every page in this app except the two prototypes is force-dynamic, so
    // there is no cached server render for revalidatePath to invalidate — each
    // navigation already renders fresh. What it DOES do is clear the client
    // router's cache for those paths, and the router then re-prefetches every
    // visible <Link>. The sidebar has 23 of them.
    //
    // One Save with eight revalidatePath calls plus one per touched store
    // produced FORTY-SIX requests: every route in the app, twice, each one a
    // real serverless render against the Singapore pooler. Netlify shed the
    // load and returned 503 on three of them — including the action's own POST
    // and one store page. The save itself had already committed, so the damage
    // was a twenty-second spinner and a page full of failed requests rather
    // than lost data, but that is luck, not design.
    //
    // router.refresh() on the client re-renders this page, which is all that is
    // needed. Everything else is force-dynamic and will be correct the moment
    // she navigates to it. The promise that this "talks to production, packing
    // slips and the forecast" is kept by the WRITE above — production reads the
    // plan, the plan reads delivery_days — not by cache invalidation.

    return { ok: true, added, removed, storesChanged: touched.size };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save the run days." };
  }
}
