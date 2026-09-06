/* Every branch of lib/driver-day.ts, and the one invariant that matters:
 * a signed-in driver is NEVER shown fabricated stops.
 *
 *   node scripts/test-driver-day.mjs
 *
 * Run against the compiled-away TS by re-declaring the logic? No -- it imports
 * the real module through tsx so a change to the source is a change to what is
 * tested. See the npx line at the bottom of ship-driver-empty-state.sh.
 */
import { driverDayMode, driverDayNote, driverDayBanner, showsSampleStops,
         packingDayHeading, packingDayNote } from "../lib/driver-day.ts";

let pass = 0;
const fails = [];
const is = (label, got, want) => {
  if (got === want) { pass++; return; }
  fails.push(`${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
};

const C = (totalStores, storesDue, planRows, unreadable = false) =>
  ({ totalStores, storesDue, planRows, unreadable });

// --- mode, every branch -----------------------------------------------------
is("has runs -> live", driverDayMode(true, true, null), "live");
is("has runs, nobody signed in -> live", driverDayMode(true, false, null), "live");
is("no runs, nobody signed in -> demo", driverDayMode(false, false, null), "demo");
is("no runs, signed in, no counts -> unreadable", driverDayMode(false, true, null), "unreadable");
is("counts threw -> unreadable", driverDayMode(false, true, C(0, 0, 0, true)), "unreadable");
is("cannot read stores -> no-access", driverDayMode(false, true, C(0, 0, 0)), "no-access");
is("stores readable, none due -> rest-day", driverDayMode(false, true, C(264, 0, 0)), "rest-day");
is("due, nothing planned -> plan-missing", driverDayMode(false, true, C(264, 144, 0)), "plan-missing");
is("due, planned, none arrived -> not-reaching", driverDayMode(false, true, C(264, 144, 1563)), "not-reaching");

// The go-live morning case, spelled out. This is the one the old banner called
// "No plan for today" -- the opposite of the truth.
is("RLS blocks the plan but not the stores -> not-reaching",
   driverDayMode(false, true, C(264, 144, 1563)), "not-reaching");

// A rest day is only a rest day if stores were readable in the first place.
is("no stores readable AND none due is no-access, not rest-day",
   driverDayMode(false, true, C(0, 0, 1563)), "no-access");

// --- the invariant ----------------------------------------------------------
const EVERY_COUNT = [
  C(0, 0, 0), C(0, 0, 0, true), C(264, 0, 0), C(264, 144, 0),
  C(264, 144, 1563), C(1, 1, 1), C(0, 144, 1563), C(264, 0, 1563),
];
for (const c of [null, ...EVERY_COUNT]) {
  for (const hasRuns of [true, false]) {
    const m = driverDayMode(hasRuns, true, c);
    is(`signed in -> never sample stops (runs=${hasRuns}, ${JSON.stringify(c)})`,
       showsSampleStops(m), false);
  }
}
is("nobody signed in, no runs -> sample stops are fine",
   showsSampleStops(driverDayMode(false, false, null)), true);
is("nobody signed in but there ARE runs -> real stops, not samples",
   showsSampleStops(driverDayMode(true, false, null)), false);

// --- the note ---------------------------------------------------------------
is("live has no note", driverDayNote("live", "Monday 7 September"), null);
for (const m of ["demo", "rest-day", "plan-missing", "not-reaching", "no-access", "unreadable"]) {
  const note = driverDayNote(m, "Monday 7 September");
  is(`${m} has a note`, typeof note === "string" && note.length > 20, true);
  // Nothing on a driver's phone says "RLS", "policy", "engine" or "plan rows".
  // Those are our words for our problem.
  is(`${m} note avoids our jargon`,
     /\b(RLS|row-level|policy|policies|engine|replenishment|current_app_role)\b/i.test(note), false);
}
// The three that are faults must all tell the driver to call, and must not
// leave them thinking it is a normal quiet day.
for (const m of ["plan-missing", "not-reaching", "no-access"]) {
  is(`${m} tells them to call`, /call the bakery/i.test(driverDayNote(m, "Monday")), true);
}
is("rest-day does not sound like a fault",
   /this is a fault/i.test(driverDayNote("rest-day", "Sunday")), false);
is("not-reaching says outright that it is a fault",
   /this is a fault/i.test(driverDayNote("not-reaching", "Monday")), true);

// --- banner vs note: never the same sentence twice on one screen ----------
is("live has no banner", driverDayBanner("live", "Monday"), null);
for (const m of ["demo", "rest-day", "plan-missing", "not-reaching", "no-access", "unreadable"]) {
  const ban = driverDayBanner(m, "Monday 7 September");
  const note = driverDayNote(m, "Monday 7 September");
  is(`${m} has a banner`, typeof ban === "string" && ban.length > 0, true);
  is(`${m} banner is short enough for one line`, ban.length <= 60, true);
  is(`${m} banner is not the whole note`, ban === note, false);
  is(`${m} banner avoids our jargon`,
     /\b(RLS|row-level|policy|policies|engine|replenishment|current_app_role)\b/i.test(ban), false);
}

// --- the packing sheet: same tree, different room -------------------------
// A packer IS at the bakery, so "call the bakery" is nonsense to them, and
// there is no van to be held up.
for (const m of ["rest-day", "plan-missing", "not-reaching", "no-access", "unreadable"]) {
  const note = packingDayNote(m, "Monday 7 September");
  const head = packingDayHeading(m, "Monday 7 September");
  is(`packing ${m} has a note`, note.length > 20, true);
  is(`packing ${m} never says call the bakery`, /call the bakery/i.test(note), false);
  is(`packing ${m} avoids our jargon`,
     /\b(RLS|row-level|policy|policies|engine plans twelve|current_app_role)\b/i.test(note.replace(/The engine plans twelve days ahead[^.]*\./, "")), false);
  is(`packing ${m} heading is non-empty`, head.length > 5, true);
}
// The three faults must name a person and must forbid packing from elsewhere.
for (const m of ["plan-missing", "not-reaching", "no-access"]) {
  is(`packing ${m} names who to tell`, /Simona or Jesse/.test(packingDayNote(m, "Monday")), true);
  is(`packing ${m} heading says it should not be empty`,
     /should not be/.test(packingDayHeading(m, "Monday")), true);
}
is("packing plan-missing forbids packing from memory",
   /do not pack from memory/i.test(packingDayNote("plan-missing", "Monday")), true);
is("packing not-reaching says outright it is a fault",
   /this is a fault/i.test(packingDayNote("not-reaching", "Monday")), true);
// A rest day stays calm and keeps the old, correct wording.
is("packing rest-day heading is the calm one",
   packingDayHeading("rest-day", "Sunday"), "Nothing to pack on Sunday");
is("packing rest-day is not alarming",
   /fault|do not pack|tell Simona/i.test(packingDayNote("rest-day", "Sunday")), false);

// --- report -----------------------------------------------------------------
if (fails.length) {
  console.error(`\n  ${fails.length} FAILED, ${pass} passed:\n`);
  for (const f of fails) console.error("    " + f + "\n");
  process.exit(1);
}
console.log(`\n  ${pass} cases pass.\n`);
