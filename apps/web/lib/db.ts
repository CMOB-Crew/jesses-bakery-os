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
const txStore = new AsyncLocalStorage<typeof sql>();

export async function withUser<T>(work: () => Promise<T>): Promise<T> {
  if (!AUTH_ENFORCED) return work();
  if (txStore.getStore()) return work(); // already inside one; never nest
  const claims = await getSessionClaims();
  // No user -> do NOT open a transaction. Fall through so each q() fails closed
  // on its own, exactly as before: empty rows, never an unscoped read.
  if (!claims) return work();
  const json = JSON.stringify(claims);
  return sql.begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${json}, true)`;
    return txStore.run(tx as unknown as typeof sql, work);
  }) as Promise<T>;
}

// Temporary, deliberate instrumentation. The Overview still overran after the
// per-request transaction landed (13,572ms) while Stores came in at 5,141ms,
// and I am not going to guess which of its twelve queries is eating the time —
// I have guessed wrong three times today already. This logs any statement over
// SLOW_MS into the Netlify function log with enough of its text to identify it.
// Remove it once the slow one is found and fixed.
const SLOW_MS = Number(process.env.SLOW_QUERY_MS ?? 300);

function label(strings: TemplateStringsArray): string {
  return strings.join("?").replace(/\s+/g, " ").trim().slice(0, 90);
}

export function q<T = unknown>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<T> {
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
