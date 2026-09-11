/* Which accounts does --rotate actually touch?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS WORTH A TEST
 * ---------------------------------------------------------------------------
 * provision-users.mjs writes to a live authentication system. Creating an
 * account and rotating one are deliberately different verbs in it: the create
 * path will NEVER reset a password somebody may already be using, and the
 * rotate path will only ever touch the roles you name.
 *
 * The thing worth being certain about is not the Supabase call. It is the
 * decision made before it: which rows in the file become a password change.
 * Get that wrong in the generous direction and you sign Simona out mid-shift
 * on the account she runs the business from; get it wrong in the mean
 * direction and one driver keeps a password that is sitting in a Slack
 * channel.
 *
 * So planRotation is a pure function and this exercises it directly. No
 * Supabase project, no network, no credentials — which is the only way a check
 * on something this sharp gets run on every push rather than once.
 *
 *   node scripts/test-provision-rotation.mjs
 */
import { planRotation } from "./provision-users.mjs";

let pass = 0;
const fails = [];
const is = (label, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fails.push(`${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
};

const PEOPLE = [
  { email: "ankit@jessesbakery.com.au",    role: "driver"  },
  { email: "manjeet@jessesbakery.com.au",  role: "driver"  },
  { email: "mohammed@jessesbakery.com.au", role: "driver"  },
  { email: "pack1@jessesbakery.com.au",    role: "packer"  },
  { email: "pack2@jessesbakery.com.au",    role: "packer"  },
  { email: "accounts@jessesbakery.com.au", role: "manager" },
  { email: "javonte@cmob.com.au",          role: "admin"   },
];
const ALL_EXIST = PEOPLE.map((p) => p.email);
const emails = (rows) => rows.map((r) => r.email);

// --- the ordinary case: rotate the floor, leave the office alone ------------
{
  const { targets, orphans } = planRotation({
    people: PEOPLE, existingEmails: ALL_EXIST, roles: new Set(["driver", "packer"]),
  });
  is("floor only: five targets", emails(targets), [
    "ankit@jessesbakery.com.au", "manjeet@jessesbakery.com.au",
    "mohammed@jessesbakery.com.au", "pack1@jessesbakery.com.au",
    "pack2@jessesbakery.com.au",
  ]);
  is("floor only: no orphans", orphans, []);
}

// --- THE ONE THAT MATTERS: the manager account is not swept up -------------
// accounts@ is the address Simona runs the business from and is signed into
// right now. "Rotate the drivers" must never reach it.
{
  const { targets } = planRotation({
    people: PEOPLE, existingEmails: ALL_EXIST, roles: new Set(["driver"]),
  });
  is("rotating drivers does not touch the manager",
     emails(targets).includes("accounts@jessesbakery.com.au"), false);
  is("rotating drivers does not touch the admin",
     emails(targets).includes("javonte@cmob.com.au"), false);
  is("rotating drivers touches exactly the drivers", emails(targets), [
    "ankit@jessesbakery.com.au", "manjeet@jessesbakery.com.au",
    "mohammed@jessesbakery.com.au",
  ]);
}

// --- an address in the file with no account behind it ----------------------
// Reported separately so the caller can REFUSE. Rotating the other four and
// quietly skipping the fifth is the worst outcome available: somebody is left
// on a password that is in a Slack channel and nobody is told.
{
  const missing = ALL_EXIST.filter((e) => e !== "manjeet@jessesbakery.com.au");
  const { targets, orphans } = planRotation({
    people: PEOPLE, existingEmails: missing, roles: new Set(["driver"]),
  });
  is("a typo'd address is an orphan, not a silent skip", emails(orphans),
     ["manjeet@jessesbakery.com.au"]);
  is("and the others are still identified", emails(targets),
     ["ankit@jessesbakery.com.au", "mohammed@jessesbakery.com.au"]);
}

// --- case ------------------------------------------------------------------
// The CSV is typed by a person and Supabase lowercases addresses. A capital
// letter must not read as "this account does not exist" and abort the run.
// BOTH SIDES. The first version of this case only varied the CSV address, so
// deleting the lowercase on the account-list side changed nothing and the test
// stayed green -- an untested line pretending to be a tested one. main() does
// lowercase its keys, so that side is belt-and-braces, but a test that cannot
// tell whether the braces are there is not testing them.
{
  const { targets, orphans } = planRotation({
    people: [{ email: "Ankit@JessesBakery.com.au", role: "driver" }],
    existingEmails: ["ankit@jessesbakery.com.au"],
    roles: new Set(["driver"]),
  });
  is("a capital in the FILE does not turn an account into an orphan", orphans.length, 0);
  is("and it is matched", targets.length, 1);
}
{
  const { targets, orphans } = planRotation({
    people: [{ email: "ankit@jessesbakery.com.au", role: "driver" }],
    existingEmails: ["Ankit@JessesBakery.com.au"],
    roles: new Set(["driver"]),
  });
  is("a capital in the ACCOUNT LIST does not either", orphans.length, 0);
  is("and it is matched too", targets.length, 1);
}

// --- "all" -----------------------------------------------------------------
// Allowed, because rotating everything after a leak is a real thing to want.
// It is only reachable by typing the word.
{
  const { targets } = planRotation({
    people: PEOPLE, existingEmails: ALL_EXIST,
    roles: new Set(["admin", "manager", "office", "driver", "packer"]),
  });
  is("all: everybody", targets.length, PEOPLE.length);
}

// --- a role nobody in the file has -----------------------------------------
{
  const { targets, orphans } = planRotation({
    people: PEOPLE, existingEmails: ALL_EXIST, roles: new Set(["office"]),
  });
  is("a role nobody has: no targets", targets.length, 0);
  is("a role nobody has: no orphans either", orphans.length, 0);
}

// --- nothing is invented ---------------------------------------------------
// An account that exists but is NOT in the file must never be rotated. The
// file is the instruction; the account list is not.
{
  const { targets } = planRotation({
    people: [{ email: "ankit@jessesbakery.com.au", role: "driver" }],
    existingEmails: [...ALL_EXIST, "zz-rehearsal-driver@cmob.com.au"],
    roles: new Set(["driver"]),
  });
  is("an account not in the file is left alone", emails(targets),
     ["ankit@jessesbakery.com.au"]);
}

if (fails.length) {
  console.error(`\n  ${fails.length} FAILED, ${pass} passed:\n`);
  for (const f of fails) console.error("    " + f + "\n");
  process.exit(1);
}
console.log(`\n  ${pass} cases pass.\n`);
