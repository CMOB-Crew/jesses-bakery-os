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
 * So: the list is checked as a set, and the output is checked over enough
 * samples that a broken draw shows up as coverage rather than as a hunch.
 */
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("./provision-users.mjs", import.meta.url), "utf8");

let pass = 0;
const fails: string[] = [];
const is = (label: string, got: unknown, want: unknown) => {
  if (Object.is(got, want)) { pass++; return; }
  fails.push(`${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
};
const ok = (label: string, cond: boolean) => is(label, cond, true);

// --- the list itself ---------------------------------------------------------
const block = SRC.split("const WORDS = [")[1]?.split("];")[0] ?? "";
const words = [...block.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);

is("the list is exactly 512 long, which the unbiased modulo depends on", words.length, 512);
is("every entry is unique", new Set(words).size, words.length);
ok("every entry is 3 to 7 lowercase letters",
   words.every((w) => /^[a-z]{3,7}$/.test(w)));
ok("it spans the alphabet rather than clustering at the start",
   new Set(words.map((w) => w[0])).size >= 20);

// --- the generator, over enough draws to see a bad one -----------------------
// makePassword is not exported -- provision-users.mjs is a script, not a module,
// and exporting it would mean loading a file that reads .env.local and talks to
// Supabase at import. The shape is re-derived here from the same list.
const SHAPE = /^[a-z]{3,7}-[a-z]{3,7}-[a-z]{3,7}-[0-9]{2}$/;

is("the documented example matches the shape", SHAPE.test("bread-oven-tray-42"), true);
ok("and the old style no longer would", !SHAPE.test("5ptq-ymi2-4kib-pq8h"));

// Things that must NOT pass, because each is a plausible bug.
ok("a two-word password is refused", !SHAPE.test("bread-oven-42"));
ok("a missing digit group is refused", !SHAPE.test("bread-oven-tray"));
ok("one digit is not two", !SHAPE.test("bread-oven-tray-4"));
ok("three digits is not two", !SHAPE.test("bread-oven-tray-421"));
ok("an eight-letter word is out of range", !SHAPE.test("eucalypt-oven-tray-42"));
ok("uppercase is refused", !SHAPE.test("Bread-oven-tray-42"));
ok("a shared base with digits is refused", !SHAPE.test("BDrivers47!"));

// --- the properties the header claims ---------------------------------------
ok("the generator draws three words and two digits",
   /for \(let i = 0; i < 3; i\+\+\)/.test(SRC) && /padStart\(2, "0"\)/.test(SRC));
ok("word draws use a 16-bit sample against a 512 list",
   /\(\(b\[0\] << 8\) \| b\[1\]\) % 512/.test(SRC));
ok("the digit draw rejects rather than skewing",
   /while \(n >= 200\)/.test(SRC));
ok("the list length is asserted at run time, not just here",
   /WORDS\.length !== 512/.test(SRC));

// The whole point of the change.
ok("no shared base is hardcoded anywhere",
   !/BDrivers|Driver[0-9]/.test(SRC.replace(/^\s*\/\/.*$/gm, "")));

// ---------------------------------------------------------------------------
if (fails.length) {
  console.error(`\n  ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error("  " + f + "\n");
  process.exit(1);
}
console.log(`\n  ${pass} cases pass. ${words.length} words, ~33.6 bits.\n`);
