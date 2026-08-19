import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Auth/RLS foundation -- Option A (Fred, 19 Aug 2026): keep the raw postgres.js
// SQL layer and inject the *verified* user's identity into each request's DB
// session. This module is the "verify" half; lib/db.ts (runAsUser) is the
// "inject" half. Nothing here runs until AUTH_ENFORCED=1 and the login flow is
// wired, so it's inert on the current build.

// The claims we inject into the DB session. `sub` is the one Postgres reads:
// Supabase's auth.uid() = (request.jwt.claims ->> 'sub')::uuid. `role` is the
// Postgres/JWT role ('authenticated'); the APPLICATION role (admin/manager/...)
// is never trusted from the token -- it's read from public.users by auth.uid().
export type UserClaims = { sub: string; role: string; email?: string };

export const AUTH_ENFORCED = process.env.AUTH_ENFORCED === "1";

let _client: SupabaseClient | null = null;
function authClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  if (!_client) {
    _client = createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _client;
}

// Verify a Supabase access token server-side and return the identity claims to
// inject, or null if auth isn't configured / the token is missing or invalid.
// v1 verifies against the Auth server (getUser); this can move to local JWKS
// verification later to drop the per-request round-trip. Fred's gotcha #3:
// verify BEFORE injecting -- never trust an unverified token's claims.
export async function verifyAccessToken(
  token: string | undefined | null,
): Promise<UserClaims | null> {
  if (!token) return null;
  const client = authClient();
  if (!client) return null;
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return { sub: data.user.id, role: "authenticated", email: data.user.email ?? undefined };
}
