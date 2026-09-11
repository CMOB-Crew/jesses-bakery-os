"use server";

// Record that a driver photographed their licence today, once the phone has
// already put the bytes in storage.
//
// No revalidatePath, for the reason set out in app/run-state-actions.ts: every
// page is force-dynamic, so there is no cached server render to invalidate.

import { q as sql } from "@/lib/db";
import { getDisplayUser } from "@/lib/supabase/server";
import { isDay, isLicencePath } from "@/lib/driver-licence-path";

export type LicenceResult = { ok: true } | { ok: false; error: string };

/**
 * WHO the licence belongs to is taken from the session, never from the caller.
 *
 * The RLS policy on driver_licences admits the driver role without scoping to
 * a person, exactly as delivery_photos has since migration 014. That is the
 * house pattern and 095 keeps it rather than inventing a per-user mechanism for
 * one table. It does mean the policy alone would not stop a driver writing a
 * row in somebody else's name -- so the application never gives it the chance.
 * The email below comes from the signed-in session and there is no parameter
 * that can override it.
 */
export async function saveDriverLicence(input: {
  day: string;
  path: string;
  sha256: string;
}): Promise<LicenceResult> {
  if (process.env.DEMO_READONLY === "1") return { ok: true };
  try {
    const { day, path, sha256 } = input;
    if (!isDay(day)) return { ok: false, error: "Bad day." };

    // Checked against the shape the upload-url route issues, not taken on
    // trust, and the day inside the path must be the day being claimed. Both
    // sides of that agreement live in lib/driver-licence-path so they cannot
    // drift apart silently -- see scripts/test-driver-licence.ts.
    if (!isLicencePath(day, path)) return { ok: false, error: "That file path is not one we issued." };
    if (!/^[0-9a-f]{64}$/i.test(sha256)) return { ok: false, error: "Bad checksum." };

    const who = await getDisplayUser().catch(() => null);
    const email = who?.email ?? null;
    if (!email) {
      // Not a crash and not a silent pass. If we cannot say whose licence this
      // is, a row would be worse than no row -- it would read as a record.
      return { ok: false, error: "We could not tell who is signed in, so the licence was not recorded." };
    }

    // user_id is a convenience, resolved from the email the same way
    // saveDeliveryProof resolves full_name. If RLS hides public.users the
    // subquery is empty, user_id lands null, and the row is still a complete
    // record -- which is why driver_email is the NOT NULL column and this is not.
    await sql`
      insert into driver_licences (user_id, driver_email, licence_date, storage_path, sha256, captured_at)
      values (
        (select u.id from public.users u where lower(u.email) = lower(${email})),
        ${email},
        ${day}::date,
        ${path},
        ${sha256.toLowerCase()},
        now())
        on conflict (driver_email, licence_date) do update
       set storage_path = excluded.storage_path,
           sha256       = excluded.sha256,
           captured_at  = excluded.captured_at,
           user_id      = coalesce(excluded.user_id, driver_licences.user_id)`;

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not record the licence." };
  }
}
