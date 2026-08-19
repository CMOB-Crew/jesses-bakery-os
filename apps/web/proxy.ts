import { type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

// Next.js 16 renamed "middleware" -> "proxy" (same mechanism). This runs before
// each matched request: it keeps the Supabase session cookie fresh and, only
// when AUTH_ENFORCED=1, bounces signed-out users to /login. Inert on the live
// site until that flag is set. See lib/supabase/proxy.ts for the logic.
export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  // Run on everything except static assets and the auth surfaces themselves,
  // so /login and /auth/* stay reachable while signed out.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|login|auth|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
