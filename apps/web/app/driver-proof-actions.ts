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

export type ProofResult = { ok: true } | { ok: false; error: string };

const KINDS = new Set(["photo", "signature"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function saveDeliveryProof(input: {
  storeId: string;
  day: string;
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
    // status and delivered_at are set here rather than left to the caller: this
    // action only ever runs after the driver has tapped Confirm, so the drop
    // has happened by definition.
    const [d] = await sql<{ id: string }[]>`
      insert into deliveries (store_id, delivery_date, status, delivered_at, driver_sig_name)
      values (${storeId}::uuid, ${day}::date, 'delivered'::delivery_status, now(), ${who?.email ?? null})
        on conflict (store_id, delivery_date) do update
       set status          = 'delivered'::delivery_status,
           delivered_at    = coalesce(deliveries.delivered_at, now()),
           driver_sig_name = coalesce(excluded.driver_sig_name, deliveries.driver_sig_name)
      returning id::text as id`;

    if (!d?.id) return { ok: false, error: "Could not record the delivery." };

    // A retake replaces. captured_at moves with it, because the time that
    // matters is when the picture that is being kept was taken.
    await sql`
      insert into delivery_photos
        (delivery_id, kind, storage_path, sha256, captured_at, gps_lat, gps_lng, gps_accuracy_m)
      values (${d.id}::uuid, ${kind}, ${path}, ${sha256.toLowerCase()}, now(),
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
