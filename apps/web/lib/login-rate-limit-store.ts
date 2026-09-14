import "server-only";
import { sql } from "@/lib/db";
import type { LimiterStore } from "./login-rate-limit";

/* ------------------------------------------------------------------ *
 * The limiter's database half. Kept apart from ./login-rate-limit so that
 * file stays pure and its rules can be asserted with no database at all --
 * see scripts/login-rate-limit-check.ts, which runs in CI with no
 * credentials.
 *
 * THREE FUNCTION CALLS, AND NOT ONE QUERY AGAINST THE TABLE.
 *
 * A rate limiter runs BEFORE anybody is signed in, so there is no session and
 * there are no claims. login_attempts has forced row-level security, which
 * means a direct read or write from here returns nothing and writes nothing --
 * silently. Migration 100 puts three SECURITY DEFINER functions in front of
 * it for exactly that reason, and they are the only way in.
 *
 * It also means the app can COUNT failures and ADD an attempt without being
 * able to READ the log, which is a list of every address that has ever tried
 * to sign in here.
 *
 * `sql` and not `q`: q resolves the signed-in user and fails closed when
 * there is none, which at the login screen is always.
 * ------------------------------------------------------------------ */

export function limiterStore(): LimiterStore {
  return {
    async countFailures(identifier, windowSeconds) {
      const rows = await sql<{ n: number }[]>`
        select login_failures_in_window(${identifier}, ${windowSeconds}) as n
      `;
      return rows[0]?.n ?? 0;
    },

    async record({ identifier, kind, outcome, ip }) {
      await sql`
        select login_attempt_record(${identifier}, ${kind}, ${outcome}, ${ip})
      `;
    },

    async purgeOlderThan(hours) {
      await sql`select login_attempts_purge(${hours})`;
    },
  };
}

/**
 * The caller's address, for the log only. The limit is keyed on the
 * identifier, never on this -- the whole bakery sits behind one connection,
 * so an IP limit would lock out the floor the moment two drivers mistype.
 *
 * Netlify sets x-nf-client-connection-ip and it is the one to trust here:
 * x-forwarded-for is a client-supplied list and its left-hand entry can be
 * anything the caller likes. Taken as a hint for a human reading the log, not
 * as an identity.
 */
export function clientIp(h: Headers): string | null {
  const nf = h.get("x-nf-client-connection-ip");
  if (nf) return nf;
  const xff = h.get("x-forwarded-for");
  if (!xff) return null;
  const first = xff.split(",")[0]?.trim();
  return first || null;
}
