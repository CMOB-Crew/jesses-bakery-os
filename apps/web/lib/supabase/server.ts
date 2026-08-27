import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { cache } from "react";
import type { UserClaims } from "@/lib/auth";

// Auth/RLS foundation -- Phase B (login flow), slice 1.
// The Supabase *session* half of Option A: read the signed-in user from the
// cookie the browser carries, server-side. This complements lib/auth.ts
// (verifyAccessToken) and lib/db.ts (runAsUser). Everything here is inert on
// the current build -- no page reads the session until the data path is wired
// and AUTH_ENFORCED=1, and if the SUPABASE env vars are unset the client is
// simply never constructed.

function supabaseEnv(): { url: string; anon: string } | null {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const anon =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return { url, anon };
}

// Server client bound to the request's cookies. Use in Server Components
// (read only) and in Server Actions / Route Handlers (read + write). Returns
// null when Supabase Auth isn't configured, so callers stay safe pre-launch.
export async function createSupabaseServerClient() {
  const env = supabaseEnv();
  if (!env) return null;
  const cookieStore = await cookies();
  return createServerClient(env.url, env.anon, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        // In a Server Component the cookie store is read-only and this throws;
        // that's expected -- the proxy (proxy.ts) refreshes the session cookie
        // on every request, so a failed set here is harmless.
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          /* called from a Server Component render -- ignore. */
        }
      },
    },
  });
}

// The verified signed-in user's claims, ready to hand to runAsUser once the
// data path is enforced. getUser() re-validates the token with the Auth server
// (not just the cookie), matching Fred's gotcha #3: verify before you trust.
// Wrapped in React `cache` so it runs at most once per request even though the
// enforced data wrapper (lib/db.ts `q`) calls it on every query -- one token
// verification per request, not per statement.
// DISPLAY ONLY. Never use this to decide what someone may see or do.
//
// getSessionClaims() above calls supabase.auth.getUser(), which re-validates the
// token against the Auth server — a network round trip to Supabase in
// ap-southeast-1. That is exactly right for the data path and Fred was right to
// insist on it: verify before you trust.
//
// It is the wrong thing to put in the root layout. The layout renders before
// every page on every route, so putting a verified read there added a serial
// round trip in front of each page's own queries — and on /login, where there
// is no session at all, it added one for nothing. On a cold Netlify function
// with a 10-second budget, talking from us-east-1 to Singapore, that is not
// free.
//
// The sidebar chip is cosmetic. It shows a name. It gates nothing — RLS and the
// proxy do that, on verified claims. So it reads the session straight from the
// request cookie, locally, with no network call. If a cookie were ever forged
// the only consequence is a wrong name in the corner of the screen.
export const getDisplayUser = cache(async (): Promise<{ email?: string; role?: string } | null> => {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    const u = data.session?.user;
    if (!u) return null;
    return { email: u.email ?? undefined, role: (u.app_metadata?.role as string | undefined) ?? undefined };
  } catch {
    return null; // never let the chip take a page down
  }
});

export const getSessionClaims = cache(async (): Promise<UserClaims | null> => {
  // TIMED. The Overview's twelve queries all reported 10-11.8 seconds and all
  // completed within 1.8s of each other — which is not twelve slow queries, it
  // is twelve fast queries behind one ~10 second stall. Every one of them waits
  // on this function, because q() resolves claims before it runs anything.
  // getUser() is a network call to the Supabase Auth server in Singapore. This
  // measures it rather than assuming it. Temporary.
  const t0 = Date.now();
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  console.log(`[auth-verify] ${Date.now() - t0}ms  getUser -> ${user ? "user" : "null"}`);
  if (!user) return null;
  return {
    sub: user.id,
    role: "authenticated",
    email: user.email ?? undefined,
  };
});
