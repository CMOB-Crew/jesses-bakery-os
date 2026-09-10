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
  // Run on everything except static assets, the auth surfaces themselves, and
  // the two endpoints that are called by a machine rather than a person.
  //
  // WHY THE MACHINE-CALLED ENDPOINTS ARE EXCLUDED. 9 September, the first time the
  // scheduled job ran, curl came back with an EMPTY body and the run failed
  // with no error to read. With AUTH_ENFORCED=1 this proxy bounces a
  // signed-out request to /login, which is a redirect carrying no body. A
  // browser test passed because the person testing it was signed in; a
  // scheduler has no cookie and never will.
  //
  // Neither endpoint is unprotected as a result. Both check FEED_POLL_SECRET
  // themselves in constant time and return 401 without it -- mail-poll at
  // route.ts and harris-farm-pull with the same guard. A session cookie is the
  // wrong instrument for a caller that is not a session, and leaning on this
  // proxy to protect them hid that.
  //
  // api/proof/audit is the third, added 10 September and for the same reason:
  // it is called weekly by a scheduler with no cookie, and it checks
  // FEED_POLL_SECRET itself. It exists at all because the alternative was
  // putting the service-role key and the database password into this public
  // repository's Actions secrets to run a read-only check.
  //
  // Only these three. Every other /api route still passes through here --
  // excluding all of /api would be one character shorter and would quietly
  // unauthenticate /api/ask and the upload routes.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|login|auth|api/feeds/mail-poll|api/feeds/harris-farm-pull|api/proof/audit|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};

