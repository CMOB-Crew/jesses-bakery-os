import postgres from "postgres";

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
