/* The floor lands on its own screen, and only sees its own screen.
 *
 *   npx tsx scripts/test-the-floor-lands-on-its-own-screen.ts
 *
 * TWO THINGS A DRIVER SAW ON 14 SEPTEMBER, ON A REAL PHONE, AT 8.56am.
 *
 *   1. The overview page, for a second or two, before being thrown to /driver.
 *   2. "A sales feed has stopped -- Harris Farm 6 days behind" across the top
 *      of his own shift screen, with a Load it link to a page he is not
 *      allowed to open.
 *
 * Both were correct code doing the wrong thing in the wrong place. RouteGuard
 * runs in the browser, so its redirect cannot beat the render it is redirecting
 * away from. FeedAlarm renders in the root layout, so it renders for everyone.
 *
 * The fixes are server-side, and the reason this test exists is that both are
 * one careless edit from coming back: move the redirect below the first await
 * and the flash returns, drop the role gate off the layout and the alarm
 * returns. Neither shows up in a typecheck and neither shows up on a desk.
 *
 * The access rules themselves are real functions with no environment behind
 * them, so those are called rather than pattern-matched. The two placements
 * cannot be called without booting Next, so those are read out of the source.
 */
import { readFileSync } from "node:fs";
import { canOpen, homeFor, hasFullAccess } from "../lib/nav-access";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const LAYOUT = read("../app/layout.tsx");
const OVERVIEW = read("../app/page.tsx");
const DRIVERAPP = read("../components/DriverApp.tsx");

let pass = 0;
const fails: string[] = [];
const is = (label: string, got: unknown, want: unknown) => {
  if (Object.is(got, want)) { pass++; return; }
  fails.push(`${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
};
const ok = (label: string, cond: boolean) => is(label, cond, true);

// --- where each role belongs -------------------------------------------------
is("a driver's home is the driver screen", homeFor("driver"), "/driver");
is("a packer's home is the packing screen", homeFor("packer"), "/packing");
is("an office user is not sent anywhere", homeFor("office"), null);
is("an admin is not sent anywhere", homeFor("admin"), null);
is("a manager is not sent anywhere", homeFor("manager"), null);
is("an account with no role yet is not sent anywhere, so the gap is visible",
   homeFor(null), null);

ok("a driver may open their own screen", canOpen("driver", "/driver"));
ok("a driver may sign out", canOpen("driver", "/auth/signout"));
ok("a driver may not open the overview", !canOpen("driver", "/"));
ok("a driver may not open the feeds page the alarm links to", !canOpen("driver", "/feeds"));
ok("a driver may not open settings", !canOpen("driver", "/settings"));
ok("a driver may not open the packing screen either", !canOpen("driver", "/packing"));
ok("a packer may not open the driver screen", !canOpen("packer", "/driver"));
ok("/driverless is not /driver with a suffix", !canOpen("driver", "/driverless"));

ok("the office has full access", hasFullAccess("office"));
ok("admin and manager do too", hasFullAccess("admin") && hasFullAccess("manager"));
ok("a driver does not", !hasFullAccess("driver"));
ok("a packer does not", !hasFullAccess("packer"));
ok("nor does an account with no role", !hasFullAccess(null));

// --- the feed alarm is gated in the layout -----------------------------------
ok("the layout gates the feed alarm on the role",
   /\{hasFullAccess\(appRole\) && <FeedAlarm \/>\}/.test(LAYOUT));
ok("and there is no ungated FeedAlarm left anywhere in it",
   (LAYOUT.match(/<FeedAlarm \/>/g) ?? []).length === 1);
ok("the layout imports the check rather than re-deciding who is who",
   /import \{ hasFullAccess \} from "@\/lib\/nav-access";/.test(LAYOUT));

// --- the overview redirects, and does it BEFORE any work ---------------------
ok("the overview redirects the floor", /if \(floorHome\) redirect\(floorHome\);/.test(OVERVIEW));

const iRedirect = OVERVIEW.indexOf("if (floorHome) redirect(floorHome);");
const iExport = OVERVIEW.indexOf("export default async function Overview()");
const iFirstQuery = OVERVIEW.indexOf("withUser(");

ok("the redirect is inside the page, not at module scope", iRedirect > iExport);
// The whole point. Below the first query it still works and the flash comes
// back, because the thirteen reads have already happened by then.
ok("the redirect happens before the first query, or it is pointless",
   iRedirect !== -1 && iFirstQuery !== -1 && iRedirect < iFirstQuery);

// --- the licence copy is true ------------------------------------------------
ok("the licence text no longer claims the photo stays on the handset",
   !/One quick photo, kept on this phone for today\./.test(DRIVERAPP));
ok("it says where the photo actually goes",
   /saved to Jesse&apos;s Bakery&apos;s\s*\n?\s*records/.test(DRIVERAPP));
ok("the upload it is describing is still wired up",
   /uploadLicence/.test(DRIVERAPP) && /saveDriverLicence/.test(DRIVERAPP));

// ---------------------------------------------------------------------------
if (fails.length) {
  console.error(`\n  ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error("  " + f + "\n");
  process.exit(1);
}
console.log(`\n  ${pass} cases pass. The floor gets one screen, and it is theirs.\n`);
