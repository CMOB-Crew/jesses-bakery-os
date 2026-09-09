import { NextRequest, NextResponse } from "next/server";
import { runAsUser, sql as sqlClient } from "@/lib/db";
import { AUTH_ENFORCED, type UserClaims } from "@/lib/auth";
import { ingestWorkbook, type SqlClient } from "@/lib/feeds/ingest";
import {
  harrisFarmConfig, harrisFarmToken, fetchVendorSalesCsv, weekEndingsToPull, HarrisFarmError,
} from "@/lib/feeds/harrisfarm";

export const dynamic = "force-dynamic";
// A week is small -- 122 rows for the week to 8 Sept -- but two weeks and a
// login is still three round trips to someone else's API.
export const maxDuration = 60;

/* ------------------------------------------------------------------ *
 * Pull Harris Farm's vendor sales.
 *
 * The other two retailers email their reports and mail-poll collects them.
 * Harris Farm sends no email and never has, so this is the equivalent: it
 * asks their API instead, and then hands the bytes to the SAME
 * ingestWorkbook() the upload screen and the mail poller use.
 *
 * Guarded exactly like mail-poll -- same secret, same identity, same
 * reasons. Both are unattended writers into sales_daily and there is no
 * case for them differing.
 *
 * ?week=20260913           one week, repeatable, for a backfill
 * ?weeks=8                 how many weeks back to walk (default 2)
 *
 * The portal's dropdown holds 170 weeks, so ?week= is how three years of
 * history gets loaded whenever someone decides they want it.
 * ------------------------------------------------------------------ */

/** Constant-time-ish compare, so the secret cannot be guessed a character at a
 *  time off response timing. Length is allowed to leak; the content is not. */
function secretMatches(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function POST(req: NextRequest) {
  return run(req);
}
// GET as well, because most schedulers only send one.
export async function GET(req: NextRequest) {
  return run(req);
}

async function run(req: NextRequest) {
  const expected = process.env.FEED_POLL_SECRET ?? "";
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "The feed puller is not switched on for this site — FEED_POLL_SECRET is not set." },
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

  const cfg = harrisFarmConfig();
  if (!cfg) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "Harris Farm is not configured — HARRIS_FARM_USERNAME and HARRIS_FARM_PASSWORD must be set. " +
          "They live in Key Vault 'jessesbakery' on Jesse's Azure tenant and belong in Supabase secrets, " +
          "never the repo. Manual upload from the portal still works in the meantime.",
      },
      { status: 501 },
    );
  }

  // Same identity requirement as mail-poll, for the same reason: with
  // AUTH_ENFORCED=1 a scheduled run has no session, so request.jwt.claims is
  // unset, current_app_role() is null, and migration 039's policy refuses the
  // first insert -- silently, for every week, every day.
  const pollUserId = process.env.FEED_POLL_USER_ID ?? "";
  if (AUTH_ENFORCED && !/^[0-9a-f-]{36}$/i.test(pollUserId)) {
    return NextResponse.json(
      { ok: false, error: "FEED_POLL_USER_ID is not set to a valid user id. With authentication enforced this run has no identity, so every row it wrote would be refused by row-level security and Harris Farm would go stale in silence." },
      { status: 501 },
    );
  }
  const claims: UserClaims | null = AUTH_ENFORCED
    ? { sub: pollUserId, role: "authenticated" }
    : null;

  /** One short transaction per week. The API fetch happens OUTSIDE it, so a
   *  slow reply from someone else's server never holds a transaction open. */
  async function db<T>(work: (sql: SqlClient) => Promise<T>): Promise<T> {
    return claims ? runAsUser(claims, (tx) => work(tx)) : work(sqlClient);
  }

  const url = new URL(req.url);
  const asked = url.searchParams.getAll("week").filter((w) => /^\d{8}$/.test(w));
  const backCount = Number(url.searchParams.get("weeks") ?? 2);
  const weeks = asked.length
    ? asked
    : weekEndingsToPull(new Date(), Number.isFinite(backCount) && backCount > 0 && backCount <= 170 ? backCount : 2);

  const results: Array<{
    week: string; status: "loaded" | "failed"; note: string;
    rowsLoaded?: number; rowsRejected?: number;
  }> = [];

  let token: string;
  try {
    token = await harrisFarmToken(cfg);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "The Harris Farm login failed.";
    const status = e instanceof HarrisFarmError && e.status === 401 ? 502 : 502;
    return NextResponse.json({ ok: false, error: msg, results }, { status });
  }

  // One week at a time, and a bad week does not stop the others. A failure on
  // the current week while last week loads is a normal Monday, not an outage.
  for (const week of weeks) {
    try {
      const file = await fetchVendorSalesCsv(cfg, token, week);
      const result = await db((sql) => ingestWorkbook(sql, "harris_farm", file.name, file.bytes));
      if (result.ok) {
        results.push({
          week, status: "loaded",
          note: `${result.rowsLoaded} loaded, ${result.rowsRejected} not loaded, from ${file.name}.`,
          rowsLoaded: result.rowsLoaded, rowsRejected: result.rowsRejected,
        });
      } else {
        results.push({ week, status: "failed", note: result.error });
      }
    } catch (e) {
      results.push({ week, status: "failed", note: e instanceof Error ? e.message : "That week could not be read." });
    }
  }

  const anyLoaded = results.some((r) => r.status === "loaded");
  return NextResponse.json(
    { ok: anyLoaded, vendorCode: cfg.vendorCode, weeks, results },
    { status: anyLoaded ? 200 : 502 },
  );
}
