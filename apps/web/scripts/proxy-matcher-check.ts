/**
 * proxy-matcher-check.ts — which paths the auth proxy runs on.
 *
 * This exists because of a failure that was invisible to every human test.
 *
 * 9 September, the first time the scheduled feed job ran, curl returned an
 * EMPTY body and the run failed with nothing to read. With AUTH_ENFORCED=1 the
 * proxy bounces a signed-out request to /login — a redirect with no body — and
 * the matcher did not exclude /api. Every browser test had passed because the
 * person running it was signed in. A scheduler has no cookie and never will.
 *
 * The rule this file defends, in both directions:
 *
 *   OUT   the two endpoints a machine calls. They authenticate themselves with
 *         FEED_POLL_SECRET in constant time and return 401 without it, so a
 *         session cookie is the wrong instrument for them.
 *   IN    everything else. Excluding all of /api would have been one character
 *         shorter and would have taken the session check off /api/ask and the
 *         upload routes, which do rely on it.
 *
 * The second half is the one worth having a test for. Widening this regex is a
 * one-line change that looks harmless and quietly unauthenticates the site.
 *
 * Run:  npx tsx scripts/proxy-matcher-check.ts
 */
import { config } from "../proxy";

const patterns = config.matcher as string[];
if (patterns.length !== 1) {
  console.log(`FAIL  expected exactly one matcher pattern, found ${patterns.length}`);
  process.exit(1);
}

// Next matches the whole path against the pattern.
const rx = new RegExp(`^${patterns[0]}$`);
const runsOn = (path: string) => rx.test(path);

let fails = 0;
function check(path: string, shouldRun: boolean, why: string) {
  const got = runsOn(path);
  const ok = got === shouldRun;
  if (!ok) fails++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${shouldRun ? "proxy runs " : "proxy skips"}  ${path}\n        ${why}`,
  );
}

console.log("— called by a machine, must NOT be bounced to /login —\n");

check("/api/feeds/mail-poll", false,
  "the scheduled morning pull. Checks FEED_POLL_SECRET itself.");
check("/api/feeds/harris-farm-pull", false,
  "the Harris Farm pull, same guard, same reason.");
check("/api/proof/audit", false,
  "the weekly proof-of-delivery audit. Same guard again — it exists as an endpoint precisely so the service-role key stays out of a public repo's Actions secrets.");

console.log("\n— called by a signed-in person, must still be protected —\n");

check("/api/ask", true, "the assistant. Reads the database as the user.");
check("/api/feeds/coles", true, "manual upload from the Feeds screen.");
check("/api/feeds/coles/upload-url", true, "signed upload URL for a browser.");
check("/api/driver/proof/upload-url", true, "a driver's proof-of-delivery upload.");
// Neighbouring paths, so a lazily-widened exclusion is caught. `api/proof`
// without the rest of the path would take the session check off anything
// added under it later.
check("/api/proof", true, "not the audit. Only the exact audit path is excluded.");
check("/api/proof/manifest", true, "a path that does not exist yet must still be protected if it ever does.");
check("/stores", true, "an ordinary page.");
check("/", true, "the Overview.");

console.log("\n— the auth surfaces themselves, or nothing would be reachable —\n");

check("/login", false, "signed-out people have to be able to reach it.");
check("/auth/callback", false, "the sign-in round trip.");

console.log("\n— static assets —\n");

check("/icon.png", false, "an image.");
check("/favicon.ico", false, "an image.");

console.log(fails === 0 ? "\nAll cases pass." : `\n${fails} case(s) FAILED.`);
process.exit(fails === 0 ? 0 : 1);
