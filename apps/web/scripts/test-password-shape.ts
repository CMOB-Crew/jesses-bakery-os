/* Does the generated password hold its shape?
 *
 *   npx tsx scripts/test-password-shape.ts
 *
 * WHY THIS IS WORTH TESTING
 *
 * A password generator fails quietly. It produces something that looks fine,
 * every time, while the distribution underneath is wrong -- a list that is not
 * a power of two so the modulo skews, a rejection loop that rejects the wrong
 * range, an off-by-one that means one word can never be drawn. None of that is
 * visible by reading three sample outputs, which is exactly how long anybody
 * looks at a password generator.
 *
 * There are two shapes now, BDriver93! for drivers and bread-oven-tray-42 for
 * everyone else, and the weaker one is weak ON PURPOSE. So the job here is not
 * to assert that passwords are strong. It is to assert that the weak shape is
 * exactly as weak as it was agreed to be and no weaker: right format, all
 * hundred numbers reachable, and never the same number twice in one run.
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const SRC = readFileSync(new URL("./provision-users.mjs", import.meta.url), "utf8");

let pass = 0;
const fails: string[] = [];
const is = (label: string, got: unknown, want: unknown) => {
  if (Object.is(got, want)) { pass++; return; }
  fails.push(`${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
};
const ok = (label: string, cond: boolean) => is(label, cond, true);

// --- the word list, which packers and every future role still use ------------
const block = SRC.split("const WORDS = [")[1]?.split("];")[0] ?? "";
const words = [...block.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);

is("the list is exactly 512 long, which the unbiased modulo depends on", words.length, 512);
is("every entry is unique", new Set(words).size, words.length);
ok("every entry is 3 to 7 lowercase letters",
   words.every((w) => /^[a-z]{3,7}$/.test(w)));
ok("it spans the alphabet rather than clustering at the start",
   new Set(words.map((w) => w[0])).size >= 20);

// --- the two shapes ----------------------------------------------------------
// makePassword is not exported -- provision-users.mjs is a script, not a module,
// and exporting it would mean loading a file that reads .env.local and talks to
// Supabase at import. The shapes are re-derived here and the source is checked
// separately, below, for the properties they depend on.
const WORD_SHAPE = /^[a-z]{3,7}-[a-z]{3,7}-[a-z]{3,7}-[0-9]{2}$/;
const DRIVER_SHAPE = /^BDriver[0-9]{2}!$/;
const PACKER_SHAPE = /^BPacker[0-9]{2}!$/;

ok("the documented driver example matches", DRIVER_SHAPE.test("BDriver93!"));
ok("so does the second one", DRIVER_SHAPE.test("BDriver81!"));
ok("the documented packer example matches", PACKER_SHAPE.test("BPacker49!"));
ok("the documented word example matches", WORD_SHAPE.test("bread-oven-tray-42"));
ok("the old sixteen-character style matches none of them",
   !DRIVER_SHAPE.test("5ptq-ymi2-4kib-pq8h") &&
   !PACKER_SHAPE.test("5ptq-ymi2-4kib-pq8h") &&
   !WORD_SHAPE.test("5ptq-ymi2-4kib-pq8h"));

// The two bases must not be interchangeable. A packer handed a BDriver
// password is a packer signing in as a driver, which is the exact thing the
// per-role screens exist to prevent.
ok("a driver password is not a packer password", !PACKER_SHAPE.test("BDriver49!"));
ok("a packer password is not a driver password", !DRIVER_SHAPE.test("BPacker49!"));

// Things that must NOT pass, because each is a plausible bug and each one would
// go out by message to somebody on the floor.
ok("the plural base is refused, it is BDriver not BDrivers", !DRIVER_SHAPE.test("BDrivers93!"));
ok("the plural packer base is refused too", !PACKER_SHAPE.test("BPackers49!"));
ok("one digit is not two", !DRIVER_SHAPE.test("BDriver9!"));
ok("three digits is not two", !DRIVER_SHAPE.test("BDriver931!"));
ok("no digits at all is refused", !DRIVER_SHAPE.test("BDriver!"));
ok("a missing exclamation mark is refused", !DRIVER_SHAPE.test("BDriver93"));
ok("lowercase b is refused", !DRIVER_SHAPE.test("bdriver93!"));
ok("lowercase b is refused for the bench as well", !PACKER_SHAPE.test("bpacker49!"));
ok("trailing whitespace is refused, it survives a copy and paste",
   !DRIVER_SHAPE.test("BDriver93! "));
ok("a word password is not a driver password", !DRIVER_SHAPE.test("bread-oven-tray-42"));

// And the word shape has to stay intact for packers.
ok("a two-word password is refused", !WORD_SHAPE.test("bread-oven-42"));
ok("one digit is not two", !WORD_SHAPE.test("bread-oven-tray-4"));
ok("an eight-letter word is out of range", !WORD_SHAPE.test("eucalypt-oven-tray-42"));
ok("uppercase is refused", !WORD_SHAPE.test("Bread-oven-tray-42"));

// --- the properties the source has to actually have --------------------------
ok("the memorable shape is opt-in by role name",
   /const MEMORABLE_BASE = \{ driver: "BDriver", packer: "BPacker" \};/.test(SRC));
ok("a role that is not listed falls through to the strong shape",
   /const base = MEMORABLE_BASE\[role\];/.test(SRC) &&
   /return base \? makeMemorablePassword\(base\) : makeWordPassword\(\);/.test(SRC));
ok("exactly two roles are on the weak shape, no more",
   (SRC.match(/"B[A-Z][a-z]+"/g) ?? []).length === 2);
ok("both call sites pass the role in",
   (SRC.match(/makePassword\(p\.role\)/g) ?? []).length === 2 &&
   !/makePassword\(\)/.test(SRC.replace(/^\s*\/\/.*$/gm, "")));
ok("no number is reused inside one run",
   /while \(used\.has\(nn\)\)/.test(SRC) && /used\.add\(nn\)/.test(SRC));
ok("the two bases have separate pools, so one cannot crowd out the other",
   /numbersUsedThisRun\.get\(base\)/.test(SRC) &&
   /numbersUsedThisRun\.set\(base, used\)/.test(SRC));
ok("running out of numbers dies rather than looping forever",
   /used\.size >= 100/.test(SRC));
ok("the digit draw rejects rather than skewing", /while \(n >= 200\)/.test(SRC));
ok("word draws use a 16-bit sample against a 512 list",
   /\(\(b\[0\] << 8\) \| b\[1\]\) % 512/.test(SRC));
ok("the list length is asserted at run time, not just here",
   /WORDS\.length !== 512/.test(SRC));

// --- the draw itself, exercised ----------------------------------------------
// Re-derived from the source above rather than imported, for the reason given
// there. Run enough times that a bad rejection range shows up as missing
// coverage instead of as a hunch.
function twoDigits(): string {
  let n: number;
  do { n = randomBytes(1)[0]; } while (n >= 200);
  return String(n % 100).padStart(2, "0");
}

const seen = new Set<string>();
for (let i = 0; i < 40000; i++) seen.add(twoDigits());
is("all one hundred numbers are reachable, including 00 and 99", seen.size, 100);
ok("00 is drawn", seen.has("00"));
ok("99 is drawn", seen.has("99"));
ok("every draw is two characters", [...seen].every((s) => /^[0-9]{2}$/.test(s)));

// The uniqueness rule, over the nine accounts it exists for. Run it many times:
// a collision among six is a 1-in-7 event per run, so a single run proves
// nothing. Per base, exactly as the source does it.
function drawRun(): string[] {
  const pools = new Map<string, Set<string>>();
  const draw = (base: string) => {
    const used = pools.get(base) ?? new Set<string>();
    pools.set(base, used);
    let nn: string;
    do { nn = twoDigits(); } while (used.has(nn));
    used.add(nn);
    return `${base}${nn}!`;
  };
  const out: string[] = [];
  for (let d = 0; d < 6; d++) out.push(draw("BDriver"));
  for (let p = 0; p < 3; p++) out.push(draw("BPacker"));
  return out;
}

let worstRun = 9;
let sawSharedNumber = false;
for (let run = 0; run < 2000; run++) {
  const out = drawRun();
  worstRun = Math.min(worstRun, new Set(out).size);
  // A driver and a packer landing on the same NUMBER is fine and expected --
  // different base, different account. If it never happened across two
  // thousand runs the pools would be wrongly shared, so this is checked too.
  const drivers = out.filter((s) => s.startsWith("BDriver")).map((s) => s.slice(7, 9));
  const packers = out.filter((s) => s.startsWith("BPacker")).map((s) => s.slice(7, 9));
  if (packers.some((n) => drivers.includes(n))) sawSharedNumber = true;
}
is("nine accounts, nine different passwords, over two thousand runs", worstRun, 9);
ok("a driver and a packer may share a number, and sometimes do", sawSharedNumber);

// ---------------------------------------------------------------------------
if (fails.length) {
  console.error(`\n  ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error("  " + f + "\n");
  process.exit(1);
}
console.log(`\n  ${pass} cases pass. Floor ~6.6 bits by decision, everyone else ~33.6.\n`);
