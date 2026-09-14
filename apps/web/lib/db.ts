import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";
import { AUTH_ENFORCED, type UserClaims } from "./auth";
import { getSessionClaims } from "./supabase/server";

// Single shared connection. In dev, Next.js hot-reload can re-run module
// init many times, so we cache the client on globalThis to avoid leaking
// pools. Swap DATABASE_URL for the Supabase pooled connection string to
// point the whole app at the hosted project — nothing else changes.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

declare global {
  var __sql: ReturnType<typeof postgres> | undefined;
}

// Supabase (and most hosted Postgres) require SSL; local dev does not.
// Detect a remote host and enable SSL automatically.
const isLocal = /@(localhost|127\.0\.0\.1)/.test(url);

export const sql =
  global.__sql ??
  postgres(url, {
    max: 8,
    idle_timeout: 20,
    ssl: isLocal ? undefined : "require",
    // Supabase's connection pooler needs prepared statements off.
    prepare: isLocal ? undefined : false,
    // Reporting reads only; the forecasting service and app writes go
    // through their own paths. Keep types predictable.
    transform: { undefined: null },
  });

if (process.env.NODE_ENV !== "production") global.__sql = sql;

// ---------------------------------------------------------------------------
// Auth/RLS foundation -- the ONE enforced data-access wrapper (Fred's crux).
//
// Once RLS is on (migration 014) and AUTH_ENFORCED=1, every query that must
// respect a user's row policies has to run through here. It:
//   1. opens a single transaction (pooled connections are shared, so identity
//      must be scoped to the transaction, not the session),
//   2. injects the *verified* claims transaction-locally --
//      set_config('request.jwt.claims', <json>, true). The `true` is Fred's #1
//      gotcha: session-level (false) persists on the pooled connection and leaks
//      the previous user's identity into the next request,
//   3. runs the caller's work against that transaction-scoped `tx`, which
//      exposes the same tagged-template API as `sql`.
//
// Anything that skips this wrapper runs with NO request.jwt.claims set, so
// auth.uid() is null and RLS returns zero rows -- fails closed, never silently
// wide open. Reads that are legitimately public (or run by the engine/service
// role) stay on `sql` directly.
//
// Inert today: no caller invokes runAsUser until the login flow is wired and
// AUTH_ENFORCED=1, so the live app is unchanged.
// ---------------------------------------------------------------------------
export async function runAsUser<T>(
  claims: UserClaims,
  work: (tx: typeof sql) => Promise<T>,
): Promise<T> {
  const json = JSON.stringify(claims);
  return sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${json}, true)`;
    return work(tx as unknown as typeof sql);
  }) as Promise<T>;
}

// ---------------------------------------------------------------------------
// The ONE enforced data-access entry point (Auth Phase B, slice 2).
//
// queries.ts / ask.ts / the write actions import THIS as `sql`
// (`import { q as sql } from "@/lib/db"`), so every existing `sql`...`` call
// routes through here with no call-site changes.
//
//   - AUTH_ENFORCED unset  (today's live site AND the demo): pass straight
//     through to the shared connection. Byte-for-byte the old behaviour.
//   - AUTH_ENFORCED = 1:    resolve the signed-in user (verified + memoized once
//     per request) and run the statement inside runAsUser, so RLS sees
//     auth.uid(). No session -> return empty: fails CLOSED, never silently open.
//
// Safe because there is no postgres.js fragment composition anywhere in the
// query layer -- every call site is a flat, awaited tagged template.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ONE transaction per REQUEST, not per query. This is the difference between
// the app loading and the app not loading.
//
// MEASURED, from the Netlify function log on 27 Aug:
//
//   01:45:56  Duration: 11649.55 ms      (Overview)
//   01:49:13  Duration: 11033.68 ms      (Stores)
//
// Netlify kills a function at 10,000 ms. Every signed-in page was being
// killed. No error, no stack — just a page that never finished, which the
// browser shows as an empty shell or "This page couldn't load".
//
// WHY IT GOT SLOW. q() below is correct and Fred's reasoning behind it is
// correct: claims must be transaction-LOCAL, because a pooled connection
// otherwise leaks one user's identity into the next request. But it meant
// every single query paid for its own transaction:
//
//   BEGIN -> set_config(claims) -> the query -> COMMIT      = 4 round trips
//
// The Overview issues twelve queries. Netlify runs in us-east-1, Supabase is
// in ap-southeast-1, and each round trip is about 130ms. Twelve queries at four
// round trips is forty-eight Pacific crossings for one page — roughly six
// seconds of nothing but network, before a single row is read. Add the auth
// verify and a cold start and you are past ten seconds.
//
// Before AUTH_ENFORCED went on it was twelve round trips. Nobody load-tested
// the app after the flag was flipped, because nobody knew it had been flipped.
//
// WHAT THIS DOES. Open the transaction once, set the claims once, and let every
// query inside the request run on that same transaction:
//
//   BEGIN -> set_config -> 12 queries -> COMMIT             = 15 round trips
//
// The queries serialise on one pinned connection instead of running eight-wide,
// which is a real cost — but 15 sequential crossings beats 48 across 8
// connections by a wide margin, and it is the same identity guarantee: still
// transaction-local, still one verified user, still fails closed.
//
// AsyncLocalStorage carries the transaction down to q() without touching a
// single call site in queries.ts. A page opts in by wrapping its data fetch in
// withUser(); anything that does not is byte-for-byte the old behaviour.
// ---------------------------------------------------------------------------
// Query timing, OFF by default. Set SLOW_QUERY_MS (e.g. 300) in the Netlify
// environment to log any statement slower than that, with enough of its text to
// identify it. This is how the 27 Aug timeout was found: a one-row query
// reporting 10.8 seconds proved the queries were queued, not slow, which no
// amount of reading the code would have shown.
//
// Left in rather than deleted, because the next time a page is slow this is the
// first thing anyone should reach for. Costs a Date.now() per query when off.
const TIMING = process.env.SLOW_QUERY_MS != null && process.env.SLOW_QUERY_MS !== "";
const SLOW_MS = Number(process.env.SLOW_QUERY_MS ?? 0);

const txStore = new AsyncLocalStorage<typeof sql>();

export async function withUser<T>(work: () => Promise<T>): Promise<T> {
  if (!AUTH_ENFORCED) return work();
  if (txStore.getStore()) return work(); // already inside one; never nest
  const claims = await getSessionClaims();
  // No user -> do NOT open a transaction. Fall through so each q() fails closed
  // on its own, exactly as before: empty rows, never an unscoped read.
  if (!claims) return work();
  const json = JSON.stringify(claims);
  // Timing is OFF unless SLOW_QUERY_MS is set. It found the thing nothing else
  // could on 27 Aug — [tx-open] vs [tx-total] split a ten second wait into
  // "getting a connection" and "doing the work" and named the culprit in one
  // deploy, after four wrong theories. Worth keeping and worth not shipping on.
  // Set SLOW_QUERY_MS in Netlify to turn it back on for an afternoon.
  const t0 = TIMING ? Date.now() : 0;
  return sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${json}, true)`;
    if (TIMING) console.log(`[tx-open] ${Date.now() - t0}ms`);
    const t1 = TIMING ? Date.now() : 0;
    try {
      return await txStore.run(tx as unknown as typeof sql, work);
    } finally {
      if (TIMING) console.log(`[tx-total] ${Date.now() - t1}ms inside the transaction`);
    }
  }) as Promise<T>;
}

function label(strings: TemplateStringsArray): string {
  return strings.join("?").replace(/\s+/g, " ").trim().slice(0, 90);
}

export function q<T = unknown>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<T> {
  if (!TIMING) {
    const plain = (client: typeof sql) =>
      (client as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<T>)(strings, ...values);
    if (!AUTH_ENFORCED) return plain(sql);
    const amb = txStore.getStore();
    if (amb) return plain(amb);
    return (async () => {
      const claims = await getSessionClaims();
      if (!claims) return [] as unknown as T;
      return runAsUser(claims, (tx) => plain(tx));
    })();
  }
  const started = Date.now();
  const timed = (r: Promise<T>): Promise<T> =>
    r.then(
      (v) => {
        const ms = Date.now() - started;
        if (ms >= SLOW_MS) console.log(`[slow-query] ${ms}ms  ${label(strings)}`);
        return v;
      },
      (e) => {
        console.log(`[query-error] ${Date.now() - started}ms  ${label(strings)}  ${e}`);
        throw e;
      },
    );
  const run = (client: typeof sql) =>
    timed(
      (client as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<T>)(
        strings,
        ...values,
      ),
    );
  if (!AUTH_ENFORCED) return run(sql);
  // Inside a withUser() request the transaction is already open and the claims
  // are already set — reuse it and skip three round trips per query.
  const ambient = txStore.getStore();
  if (ambient) return run(ambient);
  return (async () => {
    const claims = await getSessionClaims();
    if (!claims) return [] as unknown as T; // fail closed: no user -> no rows
    return runAsUser(claims, (tx) => run(tx));
  })();
}

/* ------------------------------------------------------------------ *
 * CONDITION 2: THE ASSISTANT CANNOT WRITE.
 *
 * The condition, in @Fred's words: "The AI assistant runs on a dedicated
 * read-only Postgres role with RLS applied. Never the service role."
 *
 * WHAT IT ACTUALLY WAS. lib/ask.ts imported `q` -- the same connection as
 * every other query in the app, on the `jbo_app` role. Not the service
 * role, so RLS did apply and the audit was right to say so. But `jbo_app`
 * can INSERT, UPDATE and DELETE on all 50 tables, and the assistant is the
 * one surface in this system that turns a sentence typed by a person into
 * a database call. "It only ever runs parameterised SELECTs" was true and
 * was the only thing standing between a typed question and a write.
 *
 * TWO HALVES, AND THIS IS THE HALF THAT CLOSES THE RISK.
 *
 *   1. Every assistant query now runs inside a READ ONLY transaction.
 *      Postgres rejects any write in one -- not the role, the transaction.
 *      It holds even if the connection is `jbo_app`, even if someone
 *      later points it at the service role by mistake, and even if a
 *      future branch of answerQuestion() is written carelessly. It needs
 *      no new credential, so it is true the moment this deploys.
 *
 *   2. A dedicated `jbo_assistant` role with nothing but SELECT granted.
 *      That needs a password created in Supabase and an env var set, so
 *      it is queued rather than shipped: see
 *      docs/condition-2-the-assistant-role.md. When ASSISTANT_DATABASE_URL
 *      is set this module picks it up with no further change.
 *
 * Half 1 without half 2 is a real closure, not a placeholder. Half 2
 * without half 1 would not be -- a SELECT-only role still leaves the app
 * one bad import away from the read-write connection, and the read-only
 * transaction is what makes that import harmless.
 *
 * RLS STILL APPLIES. The claims are injected transaction-locally exactly
 * as withUser() does it, with the same `true` third argument -- @Fred's
 * first gotcha, and the reason a pooled connection cannot leak one user's
 * identity into the next request. No claims and AUTH_ENFORCED on means no
 * rows, never an unscoped read.
 * ------------------------------------------------------------------ */

const assistantUrl = process.env.ASSISTANT_DATABASE_URL;

declare global {
  var __assistantSql: ReturnType<typeof postgres> | undefined;
}

const assistantSql: ReturnType<typeof postgres> | null = assistantUrl
  ? global.__assistantSql ??
    postgres(assistantUrl, {
      max: 4,
      idle_timeout: 20,
      ssl: /@(localhost|127\.0\.0\.1)/.test(assistantUrl) ? undefined : "require",
      prepare: /@(localhost|127\.0\.0\.1)/.test(assistantUrl) ? undefined : false,
      transform: { undefined: null },
    })
  : null;

if (assistantSql && process.env.NODE_ENV !== "production") {
  global.__assistantSql = assistantSql;
}

/**
 * Whether the assistant is on its own role yet, or still borrowing the
 * app's connection inside a read-only transaction. Reported by
 * scripts/assistant-is-read-only-check.ts so the difference is visible
 * rather than assumed.
 */
export const ASSISTANT_HAS_OWN_ROLE = assistantSql != null;

/**
 * Either the open read-only transaction, or a refusal.
 *
 * `denied` is the fail-closed case, and it is a distinct state on purpose:
 * AUTH_ENFORCED with no signed-in user must return no rows, and it must do
 * that WITHOUT opening a transaction -- the same shape q() uses.
 */
type AskCtx = { tx: typeof sql } | { denied: true };

const askStore = new AsyncLocalStorage<AskCtx>();

function openReadOnly<T>(claimsJson: string | null, work: () => Promise<T>): Promise<T> {
  const client = assistantSql ?? sql;
  // postgres.js appends this string to BEGIN, so the transaction is read
  // only from its first statement -- before anything has taken a snapshot.
  return client.begin("read only", async (tx) => {
    if (claimsJson) {
      await tx`select set_config('request.jwt.claims', ${claimsJson}, true)`;
    }
    return askStore.run({ tx: tx as unknown as typeof sql }, work);
  }) as Promise<T>;
}

/**
 * Run the assistant's work inside ONE read-only transaction per question.
 *
 * One per question, not one per query, for the reason documented at length
 * above withUser(): Netlify is in us-east-1 and Supabase is in
 * ap-southeast-1, and a transaction per statement costs four Pacific
 * crossings each. answerQuestion() issues up to three queries per answer.
 */
export async function withAssistant<T>(work: () => Promise<T>): Promise<T> {
  if (askStore.getStore()) return work(); // already inside one; never nest
  if (!AUTH_ENFORCED) return openReadOnly(null, work);
  const claims = await getSessionClaims();
  if (!claims) return askStore.run({ denied: true }, work);
  return openReadOnly(JSON.stringify(claims), work);
}

/**
 * The assistant's query function. Same tagged-template signature as q(),
 * so lib/ask.ts changed one import line and not one of its fifteen call
 * sites.
 *
 * A statement issued outside withAssistant() opens its own read-only
 * transaction rather than falling through to the read-write connection.
 * That is slower and deliberately so: there is no path from here to a
 * write, including the one a future caller forgets to wrap.
 */
export function aq<T = unknown>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<T> {
  const ctx = askStore.getStore();
  if (ctx && "denied" in ctx) return Promise.resolve([] as unknown as T);
  if (ctx) {
    return (ctx.tx as unknown as (s: TemplateStringsArray, ...v: unknown[]) => Promise<T>)(
      strings,
      ...values,
    );
  }
  return withAssistant(() => aq<T>(strings, ...values));
}

