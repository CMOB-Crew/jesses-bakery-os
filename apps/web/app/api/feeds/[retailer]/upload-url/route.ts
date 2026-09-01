import { NextRequest, NextResponse } from "next/server";
import { getSessionClaims } from "@/lib/supabase/server";
import { AUTH_ENFORCED } from "@/lib/auth";
import { supabaseAdmin, FEED_BUCKET } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
// Netlify's platform maximum for a synchronous function is 60 seconds. No page
// here declared one, so every page ran on a default nobody chose — and the
// function log shows cold renders at 8.6, 10.0, 10.4 and 10.7 seconds with
// nothing above that, which is the shape of a ceiling around ten.
//
// This does not make the page fast. It stops a slow render being a broken one.
export const maxDuration = 60;

/* ------------------------------------------------------------------ *
 * Mint a one-time upload URL for one retailer report.
 *
 * Netlify refuses a request body over 4.5 MiB with an empty 413 before the
 * function runs. Measured on the live app: 4,500,000 through, 4,718,592
 * refused. The Woolworths daily report is 4,906,290 bytes and grows every
 * morning, so it can never arrive as a request body.
 *
 * This hands the browser a capability instead: a URL good for ONE object at
 * ONE path, which it PUTs the file to directly. The bytes never touch Netlify.
 *
 * Authorisation is the session check below — the same one the loader does —
 * rather than a standing storage policy. The bucket needs no write permission
 * at all, which is the point.
 * ------------------------------------------------------------------ */

const RETAILERS = new Set(["coles", "woolworths", "harris_farm"]);
// The extension is echoed into the object name, so it is taken from a fixed
// set rather than from whatever the browser sent.
const EXT = /\.(xlsx|xlsm|csv)$/i;

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ retailer: string }> },
) {
  if (AUTH_ENFORCED && !(await getSessionClaims())) {
    return NextResponse.json(
      { ok: false, error: "Your session has expired. Sign in again and re-send the file." },
      { status: 401 },
    );
  }

  const { retailer } = await ctx.params;
  if (!RETAILERS.has(retailer)) {
    return NextResponse.json({ ok: false, error: `Unknown retailer "${retailer}".` }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as { filename?: string } | null;
  const ext = String(body?.filename ?? "").match(EXT)?.[0]?.toLowerCase();
  if (!ext) {
    return NextResponse.json(
      { ok: false, error: "That needs to be the .xlsx the retailer sends, or a .csv." },
      { status: 400 },
    );
  }

  const admin = supabaseAdmin();
  if (!admin) {
    // No service key on this deployment. The caller falls back to the ordinary
    // upload, which still works for everything under the limit.
    return NextResponse.json(
      { ok: false, error: "Large uploads are not switched on for this site yet — SUPABASE_SERVICE_ROLE_KEY is not set. Files under 4.4MB still upload normally." },
      { status: 501 },
    );
  }

  // The name is ours, not theirs. A uuid plus a known extension means the path
  // the browser hands back later can be checked against a shape we issued
  // rather than trusted, and two people uploading at 6am cannot collide.
  const path = `${retailer}/${crypto.randomUUID()}${ext}`;
  const { data, error } = await admin.storage.from(FEED_BUCKET).createSignedUploadUrl(path);
  if (error || !data?.signedUrl) {
    return NextResponse.json(
      { ok: false, error: "Could not start the upload. Nothing was loaded — try again." },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true, path, signedUrl: data.signedUrl });
}
