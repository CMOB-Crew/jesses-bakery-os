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
export type AppIdentity = { role: string | null; fullName: string | null };

/**
 * The role AND the name, in the ONE query the role already costs.
 *
 * Added 15 September. /account let a person set their own name and then the
 * only place their identity appears all day -- the sidebar footer, the one
 * part of the nav every role sees -- went on rendering the first half of their
 * email address. A driver could set his surname and watch nothing change.
 *
 * The name is NOT in the token, so it has to be read from public.users. It is
 * read HERE rather than in its own call because this file's own note, and the
 * longer one in app/layout.tsx, are both about the day forty-eight Pacific
 * crossings put every signed-in page over Netlify's ten second ceiling.
 * Netlify runs in us-east-1 and Supabase in ap-southeast-1, so a second round
 * trip in the root layout is paid on every page of every route. This is a
 * second COLUMN on a query that was already being made, which is free.
 *
 * The subselect needs no filtering by hand: row-level security already grants
 * a person exactly their own row of public.users, which apply-108 measured
 * standing in as a real driver. jb_uid() rather than auth.uid() because
 * jbo_app has no USAGE on schema auth -- migration 106.
 */
export const getAppIdentity = cache(async (): Promise<AppIdentity> => {
  const none: AppIdentity = { role: null, fullName: null };
  if (!AUTH_ENFORCED) return none;
  try {
    const claims = await getSessionClaims();
    if (!claims) return none;
    const rows = await runAsUser(claims, (tx) =>
      tx<{ role: string | null; full_name: string | null }[]>`
        select public.current_app_role() as role,
               (select u.full_name from public.users u where u.id = public.jb_uid())
                 as full_name`,
    );
    return { role: rows[0]?.role ?? null, fullName: rows[0]?.full_name ?? null };
  } catch {
    // Never let this take a page down. A failure here means the sidebar shows
    // everything, which is exactly today's behaviour.
    return none;
  }
});

// Unchanged for every existing caller. Both are cache()d, so a render that
// asks for the role and the identity makes ONE query between them.
export const getAppRole = cache(async (): Promise<string | null> => {
  return (await getAppIdentity()).role;
});
