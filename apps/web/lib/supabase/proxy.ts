import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_ENFORCED } from "@/lib/auth";

// Session refresh + (gated) gate-keeping for the Next.js 16 proxy (formerly
// "middleware"). Per the Next docs, the proxy is for optimistic redirects and
// keeping the session cookie fresh -- NOT the authorization layer. Real
// enforcement is row-level security + runAsUser in the data path. This only:
//   1. refreshes the Supabase auth cookie on every request (always safe), and
//   2. when AUTH_ENFORCED=1, bounces signed-out users to /login (optimistic).
//
// With AUTH_ENFORCED unset -- today's live site and the demo -- step 2 never
// runs, so behaviour is unchanged. With SUPABASE env unset, it no-ops entirely.

function supabaseEnv(): { url: string; anon: string } | null {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const anon =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) return null;
  return { url, anon };
}

// Paths that must stay reachable while signed out. (The matcher in proxy.ts
// already excludes most of these; this is defence in depth.)
function isPublicPath(pathname: string): boolean {
  return (
    pathname.startsWith("/login") ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico"
  );
}

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const env = supabaseEnv();
  if (!env) return response; // Supabase Auth not configured yet -- no-op.

  const supabase = createServerClient(env.url, env.anon, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // Refresh + validate the session. Always safe; keeps the cookie from expiring.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Gated enforcement. The demo build never enforces (no login wall for Simona).
  const demo = process.env.NEXT_PUBLIC_DEMO === "1";
  if (AUTH_ENFORCED && !demo && !user && !isPublicPath(request.nextUrl.pathname)) {
    // Send the WHOLE target through, query string included, and strip the
    // target's own parameters off the login URL. clone() copies them, so
    // /packing?day=2026-09-03 was arriving as
    //   /login?day=2026-09-03&next=%2Fpacking
    // -- the parameters littering the login URL and missing from the place
    // the user gets sent back to.
    const target = request.nextUrl.pathname + request.nextUrl.search;
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    redirectUrl.search = "";
    redirectUrl.searchParams.set("next", target);
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}
