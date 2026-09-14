"use server";

// Record that a piece of proof exists, once the phone has already put the bytes
// in storage.
//
// NO revalidatePath here, for the reason set out at length in
// app/run-state-actions.ts: every page is force-dynamic, so there is no cached
// server render to invalidate, and all revalidatePath does is clear the client
// router cache and set off a re-prefetch of every sidebar link.

import { q as sql } from "@/lib/db";
import { getDisplayUser } from "@/lib/supabase/server";

/* ------------------------------------------------------------------ *
 * ONE UPSERT, USED BY BOTH WRITE PATHS.
 *
 * There were two copies of this insert, and the comment on the second said the
 * duplication was deliberate because either path can run first. That reason is
 * about ORDER, not about having two copies -- migration 080's unique key on
 * (store_id, delivery_date) is what makes either-order safe, and it still does.
 *
 * They are one function now because condition 12 adds two more columns to
 * both, and two copies of a rule about who made a delivery is two places for
 * it to drift.
 * ------------------------------------------------------------------ */
async function upsertDelivery(input: {
  storeId: string;
  day: string;
  runId?: string | null;
  email: string | null;
}): Promise<string | null> {
  const { storeId, day, email } = input;
  // A run id that is not a uuid is not passed to the database at all.
  const runId = input.runId && UUID.test(input.runId) ? input.runId : null;

  const [d] = await sql<{ id: string }[]>`
    insert into deliveries (store_id, delivery_date, status, delivered_at,
                            driver_id, run_id, driver_sig_name)
    values (${storeId}::uuid, ${day}::date, 'delivered'::delivery_status, now(),

            -- WHO. public.users(id), which migration 098 made this column
            -- point at. Until then it referenced app_users, the legacy staff
            -- directory, and could not be filled from a signed-in account at
            -- all -- see the migration for why that is not the same as anyone
            -- forgetting to fill it.
            --
            -- Null if the account has no public.users row. A wrong driver on a
            -- delivery record is worse than no driver, and driver_sig_name
            -- still carries the person's name either way.
            (select u.id from public.users u
              where lower(u.email) = lower(${email})),

            -- WHICH RUN, and this is the "run validation" half of condition 12.
            --
            -- The run is only written if the store really is on it for that
            -- weekday: store_run_overrides for the day if there is one,
            -- otherwise stores.default_run_id. The phone chooses which run the
            -- driver is doing, and a phone is not a source of truth about
            -- which run serves a store.
            --
            -- A mismatch writes NULL rather than refusing. The delivery
            -- happened; recording it matters more than labelling it, and a
            -- silent wrong run would be read as fact by the packing sheet.
            (select r.id from runs r
              where r.id = ${runId}::uuid
                and r.id = coalesce(
                      (select o.run_id from store_run_overrides o
                        where o.store_id = ${storeId}::uuid
                          and o.day = lower(to_char(${day}::date, 'Dy'))::weekday),
                      (select s.default_run_id from stores s where s.id = ${storeId}::uuid))),

            -- The signature names a PERSON, not a login.
            --
            -- Jesse's Microsoft tenant has eleven delivery mailboxes and all
            -- eleven are numbered slots: delivery1@ .. delivery11@. If a
            -- driver is ever put on one of those, stamping the raw address
            -- here would sign the drop "delivery4@jessesbakery.com.au". A
            -- store disputing a delivery would be answered with a mailbox.
            coalesce(
              (select nullif(btrim(u.full_name), '')
                 from public.users u
                where lower(u.email) = lower(${email})),
              ${email}))
      on conflict (store_id, delivery_date) do update
     set status          = 'delivered'::delivery_status,
         delivered_at    = coalesce(deliveries.delivered_at, now()),
         -- coalesce keeps whatever is already there. A second call from the
         -- same stop -- the photo then the signature -- must not blank a
         -- driver or a run that the first call established.
         driver_id       = coalesce(deliveries.driver_id, excluded.driver_id),
         run_id          = coalesce(deliveries.run_id, excluded.run_id),
         driver_sig_name = coalesce(excluded.driver_sig_name, deliveries.driver_sig_name)
    returning id::text as id`;

  return d?.id ?? null;
}

export type ProofResult = { ok: true } | { ok: false; error: string };

const KINDS = new Set(["photo", "signature"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function saveDeliveryProof(input: {
  storeId: string;
  day: string;
  /** Which run the driver is doing. Validated against the store's own run for
   *  that weekday before it is written -- see upsertDelivery. */
  runId?: string | null;
  kind: string;
  path: string;
  sha256: string;
  lat?: number | null;
  lng?: number | null;
  accuracy?: number | null;
}): Promise<ProofResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true };
  try {
    const { storeId, day, kind, path, sha256 } = input;
    if (!UUID.test(storeId)) return { ok: false, error: "Unknown store." };
    if (!DAY.test(day)) return { ok: false, error: "Bad day." };
    if (!KINDS.has(kind)) return { ok: false, error: "Unknown kind of proof." };

    // The path is checked against the shape the upload-url route issues, not
    // taken on trust. A phone that has been tampered with cannot point a
    // delivery row at somebody else's object.
    const expected = new RegExp(
      `^${day}/${storeId}/${kind}-[0-9a-f-]{36}\\.jpg$`,
      "i",
    );
    if (!expected.test(path)) return { ok: false, error: "That file path is not one we issued." };
    if (!/^[0-9a-f]{64}$/i.test(sha256)) return { ok: false, error: "Bad checksum." };

    const who = await getDisplayUser().catch(() => null);

    // One drop per store per day (migration 080's unique key). The row may
    // already exist -- the photo is saved before the signature -- so this
    // upserts and only fills in what it knows.
    //
    // status and delivered_at are set inside upsertDelivery rather than left to
    // the caller: this action only ever runs after the driver has tapped
    // Confirm, so the drop has happened by definition.
    const deliveryId = await upsertDelivery({
      storeId, day, runId: input.runId ?? null, email: who?.email ?? null,
    });

    if (!deliveryId) return { ok: false, error: "Could not record the delivery." };

    // A retake replaces. captured_at moves with it, because the time that
    // matters is when the picture that is being kept was taken.
    await sql`
      insert into delivery_photos
        (delivery_id, kind, storage_path, sha256, captured_at, gps_lat, gps_lng, gps_accuracy_m)
      values (${deliveryId}::uuid, ${kind}, ${path}, ${sha256.toLowerCase()}, now(),
              ${input.lat ?? null}, ${input.lng ?? null}, ${input.accuracy ?? null})
        on conflict (delivery_id, kind) do update
       set storage_path    = excluded.storage_path,
           sha256          = excluded.sha256,
           captured_at     = excluded.captured_at,
           gps_lat         = excluded.gps_lat,
           gps_lng         = excluded.gps_lng,
           gps_accuracy_m  = excluded.gps_accuracy_m`;

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not save the proof." };
  }
}

/* ------------------------------------------------------------------ *
 * WHAT WAS ACTUALLY DELIVERED, line by line.
 *
 * delivery_items has been in the schema since 001 and, until now, was written
 * by NOTHING but the seed scripts. Migration 080 said so out loud in August --
 * "the moment items are ever attached" -- and that moment never came.
 *
 * Two things were reading it anyway:
 *
 *   v_store_week.total_sent          the Overview's whole "sent" figure
 *   v_store_product_delivered        added on 10 September, this morning
 *
 * So every delivery a driver recorded contributed ZERO to what the business
 * thinks it delivered, and the measured column shipped this morning was
 * structurally zero for every new drop. That is the fifth table in this system
 * found to be read by something and written by nothing, and the first one
 * where the reader was built on top of it the same day.
 *
 * WHY THE QUANTITIES COME FROM THE PHONE.
 *
 * They are not taken on trust; they are validated below. But they are the
 * right SOURCE. What a store is due on a given day is worked out partly in
 * TypeScript -- the weekday curve splits a weekly standing order into one
 * day's drop -- so recomputing it here would be a second implementation of the
 * same arithmetic, and the two would disagree the first time either changed.
 * The phone's list is also what the driver actually stood in front of and
 * signed for, which is the more truthful record of a delivery.
 *
 * WHY IT IS NOT PART OF saveDeliveryProof.
 *
 * That function only runs when there is a photo or a signature to keep. A stop
 * confirmed without either created no deliveries row at all -- the driver's own
 * screen said delivered and the business had no record. This creates the row
 * whether or not proof follows, and saveDeliveryProof still upserts the same
 * row, so the two are safe in either order.
 * ------------------------------------------------------------------ */

export type DeliveredLine = { productId: string; qty: number };
export type RecordResult =
  | { ok: true; lines: number; dropped: number }
  | { ok: false; error: string };

export async function recordDelivery(input: {
  storeId: string;
  day: string;
  /** Which run the driver is doing. Validated before it is written. */
  runId?: string | null;
  items: DeliveredLine[];
  /** What the driver pulled off the shelf, per product. An EMPTY ARRAY and a
   *  missing array mean different things -- see the note at the write. */
  waste?: DeliveredLine[] | null;
}): Promise<RecordResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true, lines: 0, dropped: 0 };
  try {
    const { storeId, day } = input;
    if (!UUID.test(storeId)) return { ok: false, error: "Unknown store." };
    if (!DAY.test(day)) return { ok: false, error: "Bad day." };

    // A stop is a handful of lines. A phone sending hundreds is a bug or a
    // tampered client, and either way this is not the place to find out how
    // large it can get.
    const raw = Array.isArray(input.items) ? input.items.slice(0, 200) : [];
    const ids: string[] = [];
    const qtys: number[] = [];
    for (const it of raw) {
      if (!it || !UUID.test(String(it.productId))) continue;
      const q = Math.round(Number(it.qty));
      if (!Number.isFinite(q) || q < 0 || q > 100000) continue;
      ids.push(String(it.productId));
      qtys.push(q);
    }

    const who = await getDisplayUser().catch(() => null);

    // The same upsert as saveDeliveryProof, and now literally the same
    // function. Either can run first, and running both is not two deliveries --
    // migration 080's unique key on (store_id, delivery_date) is what makes
    // that true.
    const deliveryId = await upsertDelivery({
      storeId, day, runId: input.runId ?? null, email: who?.email ?? null,
    });

    if (!deliveryId) return { ok: false, error: "Could not record the delivery." };
    if (!ids.length) return { ok: true, lines: 0, dropped: 0 };

    // The join to products is the last check: a product id the phone has and
    // the database does not simply does not land. A driver is NEVER blocked
    // over it -- the count comes back so the screen can say something, and the
    // delivery itself is already recorded above.
    const rows = await sql<{ product_id: string }[]>`
      insert into delivery_items (delivery_id, product_id, qty_sent)
      select ${deliveryId}::uuid, p.id, t.qty
        from unnest(${ids}::uuid[], ${qtys}::int[]) as t(pid, qty)
        join products p on p.id = t.pid
        on conflict (delivery_id, product_id) do update
       set qty_sent = excluded.qty_sent
      returning product_id::text as product_id`;

    // ----------------------------------------------------------------
    // WASTE AT THE SHELF.
    //
    // The driver app has had a wastage screen since it was built. The counts
    // lived in React state and were never sent anywhere -- and `wastage`, the
    // table they belong in, is read by the app (the product waste rollup) and
    // was written by nothing. Waste reduction is the entire premise of this
    // build and the screen that captured it threw it away.
    //
    // A CONFIRMED NIL IS NOT THE SAME AS NO ANSWER, and this is the part worth
    // getting right. v_store_week reads
    //
    //   coalesce(waste.total_wasted, greatest(sent - sold, 0))
    //
    // so an absent row means "nobody told us, so infer it from the gap". A
    // driver standing at the shelf saying there was none is better evidence
    // than that inference, and it must beat it -- which it only does if the
    // zero is WRITTEN. So nil sends a zero for every line delivered, and
    // `waste` being undefined (an older phone, or a stop with no waste screen)
    // writes nothing at all and leaves the inference in place.
    // ----------------------------------------------------------------
    if (Array.isArray(input.waste)) {
      const wid: string[] = [];
      const wq: number[] = [];
      for (const it of input.waste.slice(0, 200)) {
        if (!it || !UUID.test(String(it.productId))) continue;
        const q = Math.round(Number(it.qty));
        if (!Number.isFinite(q) || q < 0 || q > 100000) continue;
        wid.push(String(it.productId));
        wq.push(q);
      }
      if (wid.length) {
        // captured_by is deliberately left null. The column references
        // app_users, the legacy table, and pointing a modern account at it
        // would be a foreign key into the wrong identity system. Who recorded
        // it is on the delivery row, which is the same person and the same
        // moment.
        await sql`
          insert into wastage (store_id, product_id, waste_date, qty)
          select ${storeId}::uuid, p.id, ${day}::date, t.qty
            from unnest(${wid}::uuid[], ${wq}::int[]) as t(pid, qty)
            join products p on p.id = t.pid
            on conflict (store_id, product_id, waste_date) do update
           set qty = excluded.qty`;
      }
    }

    return { ok: true, lines: rows.length, dropped: ids.length - rows.length };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not record what was delivered." };
  }
}
