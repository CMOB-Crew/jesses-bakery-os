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
export const getSessionClaims = cache(async (): Promise<UserClaims | null> => {
  const supabase = await createSupabaseServerClient();
  if (!supabase) return null;
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  return {
    sub: user.id,
    role: "authenticated",
    email: user.email ?? undefined,
  };
});
