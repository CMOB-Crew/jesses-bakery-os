import { NextRequest, NextResponse } from "next/server";
import { runAsUser, sql as sqlClient } from "@/lib/db";
import { getSessionClaims } from "@/lib/supabase/server";
import { AUTH_ENFORCED } from "@/lib/auth";
import { ingestWorkbook, type SqlClient } from "@/lib/feeds/ingest";
import { supabaseAdmin, FEED_BUCKET } from "@/lib/supabase/admin";

// Exactly the shape upload-url issues: retailer/uuid.ext. The path arrives from
// the browser and goes to a service-role client that bypasses row-level
// security, so it is matched against this rather than trusted. Without it,
// "../" or another bucket's key would be handed straight through.
const SAFE_OBJECT_PATH = /^[a-z_]+\/[0-9a-f-]{36}\.(xlsx|xlsm|csv)$/i;

export const dynamic = "force-dynamic";
// A week of Coles is ~8k rows; a month is ~35k. Give it room but not forever.
export const maxDuration = 60;

/* ------------------------------------------------------------------ *
 * Take a retailer report and load it.
 *
 * This route is now only about GETTING THE BYTES HERE. Everything from the
 * parse onwards lives in lib/feeds/ingest.ts, shared with the mailbox poller,
 * so a file Simona uploads and a file we pull out of accounts@ at 9am go
 * through identical code rather than two copies that drift.
 *
 * Deliberately NOT chunked into a background job. Simona uploads a file and
 * watches it land — if it takes twelve seconds, that is twelve seconds she
 * spends knowing whether her data is in. A queue would take the answer away
 * from the moment she needs it.
 * ------------------------------------------------------------------ */

// Not 25MB, whatever this used to say. Netlify caps a request body at 4.5 MiB
// (the AWS Lambda 6MB base64 ceiling) and answers 413 without ever invoking the
// function, so anything above that never gets here to be measured against a
// constant. Measured on the live app: 4,500,000 through, 4,718,592 refused.
//
// Kept slightly under the platform's number so that if a request ever does
// arrive near the edge, it is OUR message that comes back rather than an empty
// 413 body the client has to guess at.
const MAX_BYTES = 4_400_000;

// The three retailers whose sales we ingest. 'invoice' is in the enum but
// has no report -- those are Jesse's own accounts, billed not scanned.
const RETAILERS = new Set(["coles", "woolworths", "harris_farm"]);

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ retailer: string }> },
) {
  // RLS. Every page goes through withUser(), and every write action imports
  // `q as sql`; both inject the verified claims transaction-locally. This
  // route used the raw client, so request.jwt.claims was never set,
  // current_app_role() was null, and migration 039's policy refused the very
  // first insert -- for every file, every retailer, every time. Nothing had
  // ever loaded through here, and nothing could have.
  const claims = AUTH_ENFORCED ? await getSessionClaims() : null;
  if (AUTH_ENFORCED && !claims) {
    return NextResponse.json(
      { ok: false, error: "Your session has expired. Sign in again and re-send the file." },
      { status: 401 },
    );
  }
  // One transaction for the whole load, so a crash cannot leave rows staged
  // or half-merged. The handler still catches its own errors and RETURNS,
  // so the transaction commits and the 'failed' audit row survives.
  return claims
    ? runAsUser(claims, (tx) => handle(req, ctx, tx))
    : handle(req, ctx, sqlClient);
}

async function handle(
  req: NextRequest,
  { params }: { params: Promise<{ retailer: string }> },
  sql: SqlClient,
) {
  // Validated against a fixed set, never passed through to SQL as-is.
  const { retailer } = await params;
  if (!RETAILERS.has(retailer)) {
    return NextResponse.json(
      { ok: false, error: `Unknown retailer "${retailer}".` },
      { status: 400 },
    );
  }

  // TWO WAYS THE BYTES ARRIVE, because one of them cannot carry the big file.
  //
  //   multipart   the normal path, unchanged, for anything under Netlify's
  //               4.5 MiB request-body limit.
  //   objectPath  the browser PUT the file straight to Supabase Storage with
  //               a one-time signed URL from ./upload-url, and is telling us
  //               where it landed. Netlify carries 90 bytes instead of 5MB.
  //
  // Everything after this block is identical for both — same parser, same
  // staging, same audit row. The only thing that differs is how the buffer
  // got here.
  let filename: string;
  let bytes: ArrayBuffer;

  try {
    if ((req.headers.get("content-type") ?? "").includes("application/json")) {
      const body = (await req.json().catch(() => null)) as
        { objectPath?: string; filename?: string } | null;
      const objectPath = body?.objectPath ?? "";
      if (!SAFE_OBJECT_PATH.test(objectPath)) {
        return NextResponse.json(
          { ok: false, error: "That upload reference is not one we issued. Nothing was loaded." },
          { status: 400 },
        );
      }
      const admin = supabaseAdmin();
      if (!admin) {
        return NextResponse.json(
          { ok: false, error: "Large uploads are not switched on for this site yet — SUPABASE_SERVICE_ROLE_KEY is not set. Files under 4.4MB still upload normally." },
          { status: 501 },
        );
      }
      const dl = await admin.storage.from(FEED_BUCKET).download(objectPath);
      if (dl.error || !dl.data) {
        return NextResponse.json(
          { ok: false, error: "The file uploaded but could not be read back. Nothing was loaded — send it again." },
          { status: 400 },
        );
      }
      bytes = await dl.data.arrayBuffer();
      // Removed the moment it is in memory rather than at the end. It has done
      // its only job; doing it here means none of the early returns below can
      // skip the cleanup, and the bucket never accumulates months of a
      // retailer's sales history waiting for a tidy-up that never runs.
      await admin.storage.from(FEED_BUCKET).remove([objectPath]);
      filename = body?.filename ?? objectPath.split("/").pop() ?? "report.xlsx";
    } else {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ ok: false, error: "No file was attached." }, { status: 400 });
      }
      if (file.size > MAX_BYTES) {
        // Reachable only if the client skipped the direct path.
        return NextResponse.json(
          { ok: false, error: `That file is ${(file.size / 1_000_000).toFixed(1)}MB, which is too big for this route. Reload the page and try again — the upload will send it a different way.` },
          { status: 400 },
        );
      }
      bytes = await file.arrayBuffer();
      filename = file.name;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : "That upload could not be read.";
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }

  const result = await ingestWorkbook(sql, retailer, filename, bytes);
  return result.ok
    ? NextResponse.json(result)
    : NextResponse.json({ ok: false, error: result.error }, { status: result.status });
}
