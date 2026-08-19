import postgres from "postgres";
import type { UserClaims } from "./auth";

// Single shared connection. In dev, Next.js hot-reload can re-run module
// init many times, so we cache the client on globalThis to avoid leaking
// pools. Swap DATABASE_URL for the Supabase pooled connection string to
// point the whole app at the hosted project — nothing else changes.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

declare global {
  // eslint-disable-next-line no-var
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
