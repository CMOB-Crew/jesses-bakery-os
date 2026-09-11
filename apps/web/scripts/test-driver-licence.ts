/* Does the licence path check accept what we issue, and refuse everything else?
 *
 *   npx tsx scripts/test-driver-licence.ts
 *
 * WHY THIS FILE EXISTS
 *
 * The phone never names the object it writes. It asks for a day, the server
 * builds a path around a uuid it generated, and the save action then refuses
 * any path that is not the shape it issues. That refusal is the only thing
 * standing between a tampered phone and writing a database row that points at
 * somebody else's object in the bucket -- including the delivery photographs
 * and signatures, which live in the same bucket.
 *
 * A path check is also the easiest security control in the world to write
 * almost-correctly. Leave off one anchor and "../delivery/..." walks straight
 * through it while every honest path still passes, so nothing ever looks wrong.
 * These cases are the ones that would look wrong.
 */
import { licencePath, isLicencePath, isDay, LICENCE_PREFIX } from "../lib/driver-licence-path";

let pass = 0;
const fails: string[] = [];
const is = (label: string, got: unknown, want: unknown) => {
  if (Object.is(got, want)) { pass++; return; }
  fails.push(`${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
};
const ok = (label: string, cond: boolean) => is(label, cond, true);
const no = (label: string, cond: boolean) => is(label, cond, false);

const DAY = "2026-09-14";
const ID = "0b7c1e4a-9f3d-4a21-8c55-2f6d7e8a9b01";
const P = licencePath(DAY, ID);

// --- what we issue -----------------------------------------------------------
is("the path is prefix/day/uuid.jpg", P, `${LICENCE_PREFIX}/${DAY}/${ID}.jpg`);
ok("and the checker accepts it", isLicencePath(DAY, P));
ok("uppercase hex is still a uuid", isLicencePath(DAY, licencePath(DAY, ID.toUpperCase())));

// --- the day must be the day being claimed -----------------------------------
// Without this, a phone could write today's row pointing at yesterday's object,
// or at a day it invented.
no("yesterday's object cannot be claimed as today's", isLicencePath(DAY, licencePath("2026-09-13", ID)));
no("nor a day that is not a day", isLicencePath("last-tuesday", P));
no("nor an empty day", isLicencePath("", P));

// --- traversal and prefix escapes --------------------------------------------
// The delivery photographs and signatures live in this same bucket. Every one
// of these passes an unanchored check.
no("no leading traversal", isLicencePath(DAY, `../${P}`));
no("no traversal inside the path", isLicencePath(DAY, `${LICENCE_PREFIX}/${DAY}/../../${ID}.jpg`));
no("no absolute path", isLicencePath(DAY, `/${P}`));
no("nothing may follow the extension", isLicencePath(DAY, `${P}/../../secrets.jpg`));
no("nothing may precede the prefix", isLicencePath(DAY, `driver-proof/${P}`));
no("a different prefix is not ours", isLicencePath(DAY, P.replace(LICENCE_PREFIX, "delivery")));

// --- the object name is a uuid and only a uuid -------------------------------
no("not a free-form name", isLicencePath(DAY, `${LICENCE_PREFIX}/${DAY}/licence.jpg`));
no("no slash inside the segment", isLicencePath(DAY, `${LICENCE_PREFIX}/${DAY}/${ID}/x.jpg`));
no("no space", isLicencePath(DAY, `${LICENCE_PREFIX}/${DAY}/${ID} .jpg`));
no("no query string", isLicencePath(DAY, `${P}?download=1`));
no("the extension is fixed", isLicencePath(DAY, `${LICENCE_PREFIX}/${DAY}/${ID}.php`));
no("a truncated uuid is not a uuid", isLicencePath(DAY, `${LICENCE_PREFIX}/${DAY}/${ID.slice(0, 20)}.jpg`));
no("nor a longer one", isLicencePath(DAY, `${LICENCE_PREFIX}/${DAY}/${ID}aa.jpg`));
no("non-hex is not hex", isLicencePath(DAY, `${LICENCE_PREFIX}/${DAY}/${ID.replace("0b7c", "zzzz")}.jpg`));
no("empty path", isLicencePath(DAY, ""));

// --- isDay -------------------------------------------------------------------
ok("a real day", isDay("2026-01-01"));
no("no time component", isDay("2026-01-01T00:00:00Z"));
no("not two digit years", isDay("26-01-01"));
no("not slashes", isDay("2026/01/01"));

// -----------------------------------------------------------------------------
if (fails.length) {
  console.error(`\n  ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error("  " + f + "\n");
  process.exit(1);
}
console.log(`\n  ${pass} cases pass.\n`);
