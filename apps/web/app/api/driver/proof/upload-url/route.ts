import { NextRequest, NextResponse } from "next/server";
import { getSessionClaims } from "@/lib/supabase/server";
import { AUTH_ENFORCED } from "@/lib/auth";
import { supabaseAdmin, PROOF_BUCKET } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* ------------------------------------------------------------------ *
 * Mint a one-time upload URL for one piece of proof of delivery.
 *
 * Same shape as the retailer-feed upload URL, and for the same reason: Netlify
 * refuses a request body over 4.5 MiB with an empty 413 before the function
 * runs. A phone photo is routinely 2-5MB and a modern camera can clear that on
 * its own, so posting the image through the app was never going to be reliable
 * in a van. This hands the phone a capability instead -- a URL good for ONE
 * object at ONE path -- and the bytes go straight to storage.
 *
 * The path is OURS, not the caller's. Store id, day and kind are validated and
 * reassembled here, so a phone cannot name an object outside its own stop, and
 * the path the browser hands back to the save action can be checked against a
 * shape we issued rather than trusted.
 * ------------------------------------------------------------------ */

const KINDS = new Set(["photo", "signature"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(req: NextRequest) {
  if (AUTH_ENFORCED && !(await getSessionClaims())) {
    return NextResponse.json(
      { ok: false, error: "Your session has expired. Sign in again." },
      { status: 401 },
    );
  }

  const body = (await req.json().catch(() => null)) as
    | { storeId?: string; day?: string; kind?: string }
    | null;

  const storeId = String(body?.storeId ?? "");
  const day = String(body?.day ?? "");
  const kind = String(body?.kind ?? "");

  if (!UUID.test(storeId) || !DAY.test(day) || !KINDS.has(kind)) {
    return NextResponse.json(
      { ok: false, error: "Bad request." },
      { status: 400 },
    );
  }

  const admin = supabaseAdmin();
  if (!admin) {
    // No service key on this deployment. The caller treats this as "proof not
    // switched on" and still records the delivery -- a driver must never be
    // stopped from marking a drop because an image could not be stored.
    return NextResponse.json(
      {
        ok: false,
        error:
          "Proof of delivery is not switched on for this site yet -- SUPABASE_SERVICE_ROLE_KEY is not set. The delivery is still recorded.",
      },
      { status: 501 },
    );
  }

  // day/store/kind, so an object is findable by hand in the dashboard when
  // somebody is looking for a specific drop, which is the only time anyone ever
  // goes looking. The uuid suffix keeps a retake from colliding with the object
  // it replaces while the old one is still being read.
  const path = `${day}/${storeId}/${kind}-${crypto.randomUUID()}.jpg`;

  const { data, error } = await admin.storage
    .from(PROOF_BUCKET)
    .createSignedUploadUrl(path);

  if (error || !data?.signedUrl) {
    return NextResponse.json(
      { ok: false, error: "Could not start the upload. The delivery is still recorded." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, path, token: data.token, signedUrl: data.signedUrl });
}
