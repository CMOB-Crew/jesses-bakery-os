import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/lib/db";
import { supabaseAdmin, PROOF_BUCKET } from "@/lib/supabase/admin";
import { auditProof, proofAuditFailed, proofAuditLines, type ObjectReader } from "@/lib/proof-audit";

export const dynamic = "force-dynamic";
// Existence is one SQL join, so the only thing that takes time is hashing the
// sample -- 25 objects at a few megabytes. Well inside this, and the sample is
// what to lower if a morning ever gets tight.
export const maxDuration = 60;

/* ------------------------------------------------------------------ *
 * Is every proof of delivery still there?
 *
 * WHY THIS IS AN ENDPOINT AND NOT A GITHUB JOB.
 *
 * The first version of this ran in Actions and wanted DATABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY as repository secrets. The service-role key
 * bypasses RLS entirely and DATABASE_URL carries the database password, and
 * this repository is public -- the secrets check in scripts/ says so in its own
 * header. Putting a client's production credentials there to run a weekly
 * read-only check is the wrong trade, and it was avoidable: morning-feeds.yml
 * has held no Supabase credentials since the day it was written. It curls an
 * endpoint with FEED_POLL_SECRET and the app holds the real keys on Netlify.
 * This is that pattern, and it needs no new secret at all.
 *
 * The same reasoning applies to what comes back. The full manifest carries
 * signer names and GPS fixes for every drop, so it is NOT in the default
 * response and never reaches a build artifact -- a public repository's
 * artifacts are downloadable by anyone. ?manifest=1 returns it for a person who
 * has the key and wants it.
 * ------------------------------------------------------------------ */

// Constant-time-ish compare. Same helper shape as the feed poller: a length
// check first, then every byte, so the comparison does not return early on the
// first wrong character.
function secretMatches(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function GET(req: NextRequest) {
  const expected = process.env.FEED_POLL_SECRET ?? "";
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "The proof audit is not switched on for this site — FEED_POLL_SECRET is not set." },
      { status: 501 },
    );
  }
  const given =
    req.headers.get("x-feed-poll-key") ??
    new URL(req.url).searchParams.get("key") ??
    "";
  if (!secretMatches(given, expected)) {
    return NextResponse.json({ ok: false, error: "Not authorised." }, { status: 401 });
  }

  const admin = supabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { ok: false, error: "SUPABASE_SERVICE_ROLE_KEY is not set, so the objects cannot be read back to check them." },
      { status: 501 },
    );
  }

  const params = new URL(req.url).searchParams;
  const raw = params.get("sample");
  const sample = raw != null && /^\d+$/.test(raw) ? Number(raw) : 25;
  const includeObjects = params.get("manifest") === "1";

  const read: ObjectReader = async (path) => {
    const { data, error } = await admin.storage.from(PROOF_BUCKET).download(path);
    if (error || !data) return { error: error?.message ?? "no body" };
    return Buffer.from(await data.arrayBuffer());
  };

  try {
    // sql, not q: this runs with no session, and the audit is a read over the
    // whole table by design. q() would resolve to no claims and return zero
    // rows -- which would report every proof as missing.
    const audit = await auditProof({
      sql: sql as unknown as Parameters<typeof auditProof>[0]["sql"],
      read,
      sample,
      includeObjects,
    });
    const failed = proofAuditFailed(audit);
    return NextResponse.json(
      { ok: !failed, ...audit, findings: proofAuditLines(audit) },
      // 200 either way. The caller decides what to do about ok:false, exactly
      // as it does for the feed poller; a 500 here would read as "the check
      // broke" when the check worked and found something.
      { status: 200 },
    );
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "The audit could not run." },
      { status: 500 },
    );
  }
}
