/* ---------------------------------------------------------------------------
 * The rules about who may change whose account, asserted.
 *
 *   npx tsx apps/web/scripts/people-check.ts
 *
 * lib/people-rules.ts is pure for this reason. Every rule in it exists to bound
 * what happens when account management leaves CMOB's terminal and goes to the
 * bakery, and "we think a manager cannot make themselves an admin" is not a
 * thing to believe without checking.
 *
 * The two that matter most are the escalation pair -- a manager granting
 * manager or admin, and a manager resetting an admin's password -- and the
 * lockout pair, which apply to admins too.
 * --------------------------------------------------------------------------- */

import {
  ROLES, mayManagePeople, mayActOn, mayGrant, mayChangeOwnAccount,
  wouldRemoveLastAdmin, normaliseEmail, checkNewPassword, MIN_PASSWORD,
  checkName, nameHint, MAX_NAME,
} from "../lib/people-rules";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "\n        " + detail : ""}`);
}

console.log("\n— who can open it at all —\n");

check("an admin can", mayManagePeople("admin"));
check("a manager can", mayManagePeople("manager"));
check("office cannot",
  !mayManagePeople("office"),
  "office sees every screen in the app and still has no business resetting passwords");
check("a driver cannot", !mayManagePeople("driver"));
check("a packer cannot", !mayManagePeople("packer"));
check("an account with no role cannot", !mayManagePeople(null));
check("an invented role cannot", !mayManagePeople("superuser"));

console.log("\n— what a manager may touch —\n");

check("a manager may act on a driver", mayActOn("manager", "driver").ok);
check("a manager may act on a packer", mayActOn("manager", "packer").ok);
check("a manager may finish setting up an account with no role yet",
  mayActOn("manager", null).ok,
  "a new starter lands with role NULL by design; finishing that is the ordinary case");

check("A MANAGER MAY NOT TOUCH AN ADMIN",
  !mayActOn("manager", "admin").ok,
  "this is the escalation hole -- resetting an admin password is becoming one");
check("a manager may not touch another manager", !mayActOn("manager", "manager").ok);
check("a manager may not touch office", !mayActOn("manager", "office").ok);
check("and the refusal names the role rather than saying 'no'",
  /admin/.test((mayActOn("manager", "admin") as { reason: string }).reason));

check("an admin may touch every role",
  ROLES.every((r) => mayActOn("admin", r).ok));

console.log("\n— what a manager may grant —\n");

check("a manager may create a driver", mayGrant("manager", "driver").ok);
check("a manager may create a packer", mayGrant("manager", "packer").ok);
check("A MANAGER MAY NOT GRANT ADMIN",
  !mayGrant("manager", "admin").ok,
  "a manager who can grant admin IS an admin, one step removed");
check("A MANAGER MAY NOT GRANT MANAGER",
  !mayGrant("manager", "manager").ok,
  "same hole, one step further round");
check("a manager may not grant office", !mayGrant("manager", "office").ok);
check("an admin may grant every real role",
  ROLES.every((r) => mayGrant("admin", r).ok));
check("nobody may grant a role the database would refuse",
  !mayGrant("admin", "superuser").ok && !mayGrant("manager", "superuser").ok);
check("office may grant nothing", !mayGrant("office", "driver").ok);

console.log("\n— locking yourself out —\n");

check("you cannot switch off your own account",
  !mayChangeOwnAccount("u1", "u1", "deactivate").ok);
check("you cannot change your own role",
  !mayChangeOwnAccount("u1", "u1", "role").ok);
check("and you can still act on somebody else",
  mayChangeOwnAccount("u1", "u2", "deactivate").ok && mayChangeOwnAccount("u1", "u2", "role").ok);

console.log("\n— the last admin —\n");

const lastAdmin = { role: "admin", is_active: true };
const otherAdmin = { role: "admin", is_active: true };
const aDriver = { role: "driver", is_active: true };
const offAdmin = { role: "admin", is_active: false };

check("THE LAST ACTIVE ADMIN CANNOT BE SWITCHED OFF",
  !wouldRemoveLastAdmin(lastAdmin, 1, { deactivating: true }).ok,
  "an empty admin list means account management is gone and only CMOB can restore it");
check("the last active admin cannot be demoted",
  !wouldRemoveLastAdmin(lastAdmin, 1, { newRole: "manager" }).ok);
check("an admin CAN be switched off when there is another one",
  wouldRemoveLastAdmin(otherAdmin, 2, { deactivating: true }).ok);
check("setting the last admin's role to admin again is not a removal",
  wouldRemoveLastAdmin(lastAdmin, 1, { newRole: "admin" }).ok,
  "a no-op must not be refused, or the screen argues with itself");
check("a driver is not the last admin",
  wouldRemoveLastAdmin(aDriver, 1, { deactivating: true }).ok);
check("an ALREADY inactive admin does not count as the last one",
  wouldRemoveLastAdmin(offAdmin, 0, { deactivating: true }).ok,
  "jb_role() ignores inactive rows, so an inactive admin is not an admin to any policy");

console.log("\n— the email, because it is the login —\n");

check("an address is trimmed and lowercased",
  (normaliseEmail("  Fred@HouseOfHero.co ") as { email: string }).email === "fred@houseofhero.co");
check("empty is refused", !normaliseEmail("   ").ok);
check("something with no @ is refused", !normaliseEmail("fred").ok);
check("something with no domain dot is refused", !normaliseEmail("fred@houseofhero").ok);
check("a normal address passes", normaliseEmail("ankit@jessesbakery.com.au").ok);
check("a plus address passes",
  normaliseEmail("simona+bakery@jessesbakery.com.au").ok,
  "rejecting these is a classic own goal and they are real addresses");

console.log("\n— changing your own password —\n");

const pw = (over: Partial<Parameters<typeof checkNewPassword>[0]>) =>
  checkNewPassword({
    next: "harbour-ferry-tuesday",
    confirm: "harbour-ferry-tuesday",
    current: "BDriver47!",
    email: "ankit@jessesbakery.com.au",
    ...over,
  });

check("a long passphrase is accepted with no rules about symbols",
  pw({}).ok,
  "composition rules are why people write passwords on the delivery sheet");
check(`shorter than ${MIN_PASSWORD} characters is refused`,
  !pw({ next: "short1", confirm: "short1" }).ok);
check("the two new ones have to match",
  !pw({ confirm: "harbour-ferry-wednesday" }).ok);
check("the new one cannot be the one you already have",
  !pw({ next: "BDriver47!", confirm: "BDriver47!" }).ok,
  "otherwise it says changed, nothing changed, and somebody thinks they are safe");
check("the old one is required",
  !pw({ current: "" }).ok,
  "a signed-in session is a laptop somebody walked away from");

check("A PASSWORD CONTAINING YOUR OWN EMAIL NAME IS REFUSED",
  !pw({ next: "ankit-is-here-today", confirm: "ankit-is-here-today" }).ok,
  "whoever is guessing already has the list of addresses");
check("and it says which word it objected to",
  /ankit/.test((pw({ next: "ankit-is-here-today", confirm: "ankit-is-here-today" }) as { reason: string }).reason));
check("a short email local part does not block half the dictionary",
  pw({ email: "jo@jessesbakery.com.au" }).ok,
  "two letters would match almost anything and refuse good passwords");

check("a trailing space is refused rather than locking somebody out",
  !pw({ next: "harbour-ferry-tue ", confirm: "harbour-ferry-tue " }).ok,
  "it survives a copy and paste and then cannot be typed back");
check("a leading space too",
  !pw({ next: " harbour-ferry-tue", confirm: " harbour-ferry-tue" }).ok);
check("a space in the MIDDLE is fine",
  pw({ next: "harbour ferry tuesday", confirm: "harbour ferry tuesday" }).ok,
  "refusing those would rule out the passphrases this is trying to encourage");

console.log("\n— your own name, which ends up on a delivery receipt —\n");

check("an ordinary name is accepted", checkName("Ankit Sharma").ok);
check("A SINGLE NAME IS ACCEPTED",
  checkName("Ankit").ok,
  "some people have one name; refusing theirs to catch a missing surname is the wrong trade");
check("and a single name gets a hint rather than a refusal",
  nameHint("Ankit") !== null && checkName("Ankit").ok);
check("a name with a surname gets no hint", nameHint("Ankit Sharma") === null);

check("an apostrophe is fine", checkName("Siobhan O\u0027Donnell").ok,
  "name validation is where software is most confidently wrong about people");
check("a hyphen is fine", checkName("Jean-Luc Moreau").ok);
check("a name outside the Latin alphabet is fine", checkName("\u674e\u5a1c").ok);
check("several spaces are fine", checkName("Maria del Carmen Garcia Lopez").ok);

check("empty is refused", !checkName("   ").ok);
check(`longer than ${MAX_NAME} is refused`, !checkName("a".repeat(MAX_NAME + 1)).ok);
check("exactly the limit is accepted", checkName("a".repeat(MAX_NAME)).ok,
  "an off-by-one here refuses a name that fits");
check("A LINE BREAK IS REFUSED",
  !checkName("Ankit\nSharma").ok,
  "it corrupts every layout it lands in, and one of them is the delivery evidence");
check("surrounding space is trimmed rather than refused",
  checkName("  Ankit Sharma  ").ok,
  "a pasted name with a space is a person being helpful, not an error");

console.log(
  fails === 0
    ? "\n  All checks pass. A manager can run the floor and cannot become an admin.\n"
    : `\n  ${fails} FAILED.\n`,
);
process.exit(fails === 0 ? 0 : 1);
