import { NextRequest, NextResponse } from "next/server";
import { runAsUser, sql as sqlClient } from "@/lib/db";
import { AUTH_ENFORCED, type UserClaims } from "@/lib/auth";
import { ingestWorkbook, type SqlClient } from "@/lib/feeds/ingest";
import {
  graphConfig, graphToken, listMessages, listAttachments, downloadAttachment, GraphError,
} from "@/lib/feeds/graph";
import { ruleFor, pickReport } from "@/lib/feeds/mailbox";

export const dynamic = "force-dynamic";
// Two workbooks, the larger 4.9MB and 100,501 rows. Netlify's platform maximum
// for a synchronous function is 60 seconds and that is what this needs to be
// allowed to take; ?retailer= exists so a bad morning can be run one at a time.
export const maxDuration = 60;

/* ------------------------------------------------------------------ *
 * Pull the morning sales reports out of the mailbox.
 *
 * Woolworths lands ~7:23am and Coles ~8:22am, both to accounts@, so one run
 * around 9am Sydney catches both with room for a late send.
 *
 * Nothing here is clever: find the message, take the attachment, hand the bytes
 * to the same ingestWorkbook() the upload screen uses. The value is entirely in
 * what it refuses to do quietly -- every message it looks at ends up in
 * feed_mail_seen with an outcome, so "the feed is fine" is a claim with rows
 * behind it rather than an absence of complaints.
 * ------------------------------------------------------------------ */

// A morning's lookback. Wide enough that a missed run, a late send or a
// weekend does not lose a file; the dedupe on message id is what stops the
// same report loading twice, not a tight window.
const DEFAULT_LOOKBACK_HOURS = 36;

type SeenStatus = "loaded" | "failed" | "skipped";

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
      { ok: false, error: "The mailbox poller is not switched on for this site — FEED_POLL_SECRET is not set." },
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

  const cfg = graphConfig();
  if (!cfg) {
    return NextResponse.json(
      { ok: false, error: "Microsoft Graph is not configured — GRAPH_TENANT_ID, GRAPH_CLIENT_ID and GRAPH_CLIENT_SECRET must be set. Manual upload still works." },
      { status: 501 },
    );
  }

  // WHO THIS RUNS AS, and why it is not optional.
  //
  // Once AUTH_ENFORCED=1 the app connects as jbo_app and every insert is
  // subject to RLS. A cron has no session, so without an identity here
  // request.jwt.claims is unset, current_app_role() is null, and migration
  // 039's policy refuses the first insert -- silently, for every file, every
  // morning. That is the exact failure this route exists to prevent, and the
  // exact bug the upload route already shipped with once.
  //
  // FEED_POLL_USER_ID must be the auth.users id of a real account that has a
  // row in public.users with role 'office' (or higher). public.users.id is a
  // foreign key to auth.users, so it has to be a genuine account, not a made-up
  // uuid. Refuse loudly rather than run and write nothing.
  const pollUserId = process.env.FEED_POLL_USER_ID ?? "";
  if (AUTH_ENFORCED && !/^[0-9a-f-]{36}$/i.test(pollUserId)) {
    return NextResponse.json(
      { ok: false, error: "FEED_POLL_USER_ID is not set to a valid user id. With authentication enforced, the poller has no identity, so every row it tried to write would be refused by row-level security and the feed would go stale in silence." },
      { status: 501 },
    );
  }
  const claims: UserClaims | null = AUTH_ENFORCED
    ? { sub: pollUserId, role: "authenticated" }
    : null;

  /** One short transaction per step. The Graph downloads deliberately happen
   *  OUTSIDE these, so a 5MB fetch never holds a database transaction open. */
  async function db<T>(work: (sql: SqlClient) => Promise<T>): Promise<T> {
    return claims ? runAsUser(claims, (tx) => work(tx)) : work(sqlClient);
  }

  const url = new URL(req.url);
  const only = url.searchParams.get("retailer");
  const hours = Number(url.searchParams.get("hours") ?? DEFAULT_LOOKBACK_HOURS);
  const lookback = Number.isFinite(hours) && hours > 0 && hours <= 720 ? hours : DEFAULT_LOOKBACK_HOURS;
  const sinceIso = new Date(Date.now() - lookback * 3600_000).toISOString();

  const results: Array<{
    retailer: string; subject: string; receivedAt: string;
    status: SeenStatus; note: string; rowsLoaded?: number; rowsRejected?: number;
  }> = [];

  try {
    const token = await graphToken(cfg);
    const messages = await listMessages(cfg, token, sinceIso);

    for (const msg of messages) {
      const rule = ruleFor(msg);
      if (!rule) continue;                       // ordinary mail; not ours to touch
      if (only && rule.retailer !== only) continue;

      // CLAIM IT FIRST. The insert is the lock: if another run (or a retry
      // after a timeout) already has this message, the conflict does nothing
      // and we move on, so the same report can never load twice.
      const claimed = await db(async (sql) => {
        const rows = await sql<{ message_id: string }[]>`
          insert into feed_mail_seen (message_id, retailer, subject, received_at, status, note)
          values (${msg.id}, ${rule.retailer}::retailer_type, ${msg.subject},
                  ${msg.receivedAt || null}, 'running', '')
          on conflict (message_id) do nothing
          returning message_id`;
        return rows.length > 0;
      });
      if (!claimed) continue;

      const finish = (status: SeenStatus, note: string, uploadId: string | null) =>
        db(async (sql) => {
          await sql`
            update feed_mail_seen
               set status = ${status}, note = ${note.slice(0, 500)},
                   upload_id = ${uploadId}::uuid, finished_at = now()
             where message_id = ${msg.id}`;
        });

      try {
        const attachments = await listAttachments(cfg, token, msg.id);
        const report = pickReport(attachments);
        if (!report) {
          const note = `That email had ${attachments.length} attachment(s) but none of them was a spreadsheet.`;
          await finish("skipped", note, null);
          results.push({ retailer: rule.retailer, subject: msg.subject, receivedAt: msg.receivedAt, status: "skipped", note });
          continue;
        }

        // Outbound fetch, so Netlify's 4.5 MiB REQUEST-body ceiling does not
        // apply -- which is the whole reason this can take the 4.9MB
        // Woolworths workbook without the signed-URL detour the browser needs.
        const bytes = await downloadAttachment(cfg, token, msg.id, report.id);
        const result = await db((sql) => ingestWorkbook(sql, rule.retailer, report.name, bytes));

        if (result.ok) {
          const note = `${result.rowsLoaded} loaded, ${result.rowsRejected} not loaded, from ${report.name}.`;
          await finish("loaded", note, result.uploadId);
          results.push({
            retailer: rule.retailer, subject: msg.subject, receivedAt: msg.receivedAt,
            status: "loaded", note, rowsLoaded: result.rowsLoaded, rowsRejected: result.rowsRejected,
          });
        } else {
          await finish("failed", result.error, null);
          results.push({ retailer: rule.retailer, subject: msg.subject, receivedAt: msg.receivedAt, status: "failed", note: result.error });
        }
      } catch (e) {
        const note = e instanceof Error ? e.message : "Something went wrong reading that email.";
        await finish("failed", note, null);
        results.push({ retailer: rule.retailer, subject: msg.subject, receivedAt: msg.receivedAt, status: "failed", note });
      }
    }

    return NextResponse.json({
      ok: true,
      mailbox: cfg.mailbox,
      since: sinceIso,
      looked: messages.length,
      handled: results.length,
      results,
    });
  } catch (e) {
    // A Graph failure is the interesting one: consent never granted, or the
    // 2028 secret lapsed. Both come back as sentences that name the fix.
    const msg =
      e instanceof GraphError ? e.message
      : e instanceof Error ? e.message
      : "The mailbox poll failed.";
    const status = e instanceof GraphError ? (e.status === 429 ? 503 : 502) : 500;
    return NextResponse.json({ ok: false, error: msg, results }, { status });
  }
}
