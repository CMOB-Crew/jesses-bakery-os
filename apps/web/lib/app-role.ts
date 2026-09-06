import "server-only";
import { cache } from "react";
import { runAsUser } from "./db";
import { AUTH_ENFORCED } from "./auth";
import { getSessionClaims } from "./supabase/server";

/* ---------------------------------------------------------------------------
 * The signed-in person's application role, once per request.
 *
 * NOT from the token. Migration 012 is explicit about this and 065 had to go
 * fix a readiness check that got it wrong: "role NULL = no access; an admin
 * grants a real role. Read by security-definer helpers, NEVER trusted from the
 * token." app_metadata.role is always undefined here, deliberately.
 *
 * So it comes from public.users.role, read through current_app_role(), which is
 * SECURITY DEFINER and therefore returns the right answer both before the RLS
 * flip and after it.
 *
 * cache() is React's per-request memo: the layout asks once, and any other
 * caller in the same render gets the same answer without a second round trip.
 * That matters more here than it looks -- Netlify runs in us-east-1 and
 * Supabase in ap-southeast-1, and lib/db.ts carries a long note about the day
 * forty-eight Pacific crossings put every signed-in page over Netlify's ten
 * second ceiling. This adds ONE query to a request that is already doing auth
 * work, and only when auth is enforced.
 *
 * Returns null when nobody is signed in, when auth is off, or when anything at
 * all goes wrong. A null role is treated as unrestricted by nav-access.ts -- see
 * the note there for why that is the right way round.
 * --------------------------------------------------------------------------- */
export const getAppRole = cache(async (): Promise<string | null> => {
  if (!AUTH_ENFORCED) return null;
  try {
    const claims = await getSessionClaims();
    if (!claims) return null;
    const rows = await runAsUser(claims, (tx) =>
      tx<{ role: string | null }[]>`select public.current_app_role() as role`,
    );
    return rows[0]?.role ?? null;
  } catch {
    // Never let this take a page down. A failure here means the sidebar shows
    // everything, which is exactly today's behaviour.
    return null;
  }
});
