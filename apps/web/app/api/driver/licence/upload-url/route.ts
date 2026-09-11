import { NextRequest, NextResponse } from "next/server";
import { getSessionClaims } from "@/lib/supabase/server";
import { AUTH_ENFORCED } from "@/lib/auth";
import { supabaseAdmin, PROOF_BUCKET } from "@/lib/supabase/admin";
import { isDay, licencePath } from "@/lib/driver-licence-path";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* ------------------------------------------------------------------ *
 * Mint a one-time upload URL for one driver licence photograph.
 *
 * A near-copy of the proof-of-delivery route next door, and deliberately a
 * COPY rather than a widening of it. That route's path check is what stops a
 * tampered phone pointing a delivery row at somebody else's object; adding a
 * third "kind" to it would have meant loosening the storeId requirement for
 * every caller, to add a feature. Thirty duplicated lines is the cheaper trade.
 *
 * Same bucket as the delivery proof, under a licence/ prefix. Migration 094
 * exists because bucket visibility is the part of this stack that fails
 * silently, so this does not introduce a second bucket and a dashboard step
 * somebody would have to remember on Monday morning.
 *
 * The path is OURS. The caller supplies a day and nothing else; the object name
 * is a uuid generated here. A phone cannot name the object it writes.
 * ------------------------------------------------------------------ */

export async function POST(req: NextRequest) {
  if (AUTH_ENFORCED && !(await getSessionClaims())) {
    return NextResponse.json(
      { ok: false, error: "Your session has expired. Sign in again." },
      { status: 401 },
    );
  }

  const body = (await req.json().catch(() => null)) as { day?: string } | null;
  const day = String(body?.day ?? "");
  if (!isDay(day)) {
    return NextResponse.json({ ok: false, error: "Bad request." }, { status: 400 });
  }

  const admin = supabaseAdmin();
  if (!admin) {
    // No service key on this deployment. The caller treats this as "licence
    // capture is not switched on" and lets the driver start their shift anyway.
    // A driver must never be stopped from working because an image would not
    // store -- blocking on it would be a worse version of the very mistake this
    // commit exists to fix.
    return NextResponse.json(
      {
        ok: false,
        error:
          "Licence capture is not switched on for this site yet -- SUPABASE_SERVICE_ROLE_KEY is not set. Your shift still starts.",
      },
      { status: 501 },
    );
  }

  const path = licencePath(day, crypto.randomUUID());

  const { data, error } = await admin.storage
    .from(PROOF_BUCKET)
    .createSignedUploadUrl(path);

  if (error || !data?.signedUrl) {
    return NextResponse.json(
      { ok: false, error: "Could not start the upload. Your shift still starts." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, path, token: data.token, signedUrl: data.signedUrl });
}
