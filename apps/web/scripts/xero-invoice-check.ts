/**
 * xero-invoice-check.ts — what gets billed, and what refuses to be billed.
 *
 * The invoice is the one screen in this system that moves money out of a
 * real customer's account. Every rule below exists because the data has
 * the shape that would break it, and none of them can be checked by
 * looking at production, because production has never sent an invoice.
 *
 * Run:  npx tsx scripts/xero-invoice-check.ts
 */
import { buildInvoice, weekQty, idempotencyKey, weekStart } from "../lib/xero-invoice";
import type { StandingLine } from "../lib/queries";

const line = (p: Partial<StandingLine> & { name: string }): StandingLine => ({
  product_id: p.product_id ?? p.name.toLowerCase().replace(/\W+/g, "-"),
  name: p.name,
  category: "sourdough",
  pack_size: 1,
  baking_uom: null,
  sent: p.sent ?? 0,
  override_qty: p.override_qty ?? null,
  mode: null,
  starts_on: null,
  ends_on: null,
  unit_price: p.unit_price ?? null,
  xero_code: p.xero_code ?? null,
  days: p.days ?? null,
} as StandingLine);

const STORE = { xero_contact_id: "c0ffee00-0000-0000-0000-000000000001", name: "KRINSKYS" };

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "\n        " + detail : ""}`);
}

console.log("— quantity —\n");

check("weekly number when there is no day grid",
  weekQty(line({ name: "White Sourdough", sent: 2 })) === 2);

check("an override beats the carried-forward number",
  weekQty(line({ name: "White Sourdough", sent: 2, override_qty: 5 })) === 5);

check("a day grid is the week, not the weekly number",
  weekQty(line({ name: "White Sourdough", sent: 99, override_qty: 99,
                 days: { mon: 4, wed: 0, fri: 9 } })) === 13,
  "the store profile's effective() reads override_qty ?? sent and would bill 99");

check("a zeroed day is a real instruction, not a missing one",
  weekQty(line({ name: "White Sourdough", days: { mon: 0, wed: 0 } })) === 0);

console.log("\n— what bills —\n");

const good = buildInvoice(STORE, [
  line({ name: "Challah - Semisweet Sesame", sent: 17, unit_price: 4.70, xero_code: "CH-SS" }),
  line({ name: "Sourdough - White", sent: 2, unit_price: 5.00, xero_code: "SD-W" }),
  line({ name: "Bagel - Plain (X 5)", sent: 4, unit_price: 5.20, xero_code: "BG-P5" }),
]);
check("three priced, coded lines bill", good.ok && good.lines.length === 3);
check("the total is the sum of the lines",
  good.total === 79.9 + 10 + 20.8,
  `got ${good.total}, expected ${79.9 + 10 + 20.8}`);

const zeroed = buildInvoice(STORE, [
  line({ name: "Sourdough - White", sent: 2, unit_price: 5.0, xero_code: "SD-W" }),
  line({ name: "Cancelled Line", sent: 0, unit_price: 5.0, xero_code: "X" }),
]);
check("a line the customer is not getting is not billed",
  zeroed.ok && zeroed.lines.length === 1);

console.log("\n— what refuses —\n");

const unpriced = buildInvoice(STORE, [
  line({ name: "Sourdough - White", sent: 2, unit_price: 5.0, xero_code: "SD-W" }),
  line({ name: "Oasis Sourdough", sent: 3, unit_price: null, xero_code: "SD-O" }),
]);
check("an unpriced line refuses the invoice rather than billing zero",
  !unpriced.ok && unpriced.refusals.some((r) => r.lines.includes("Oasis Sourdough")),
  unpriced.refusals.map((r) => r.reason).join(" | "));

const uncoded = buildInvoice(STORE, [
  line({ name: "Sourdough - White", sent: 2, unit_price: 5.0, xero_code: "SD-W" }),
  line({ name: "Oasis Olympic Park Sourdough", sent: 3, unit_price: 4.9, xero_code: null }),
]);
check("a priced line with no Xero code refuses rather than guesses",
  !uncoded.ok && uncoded.refusals.some((r) => r.lines.includes("Oasis Olympic Park Sourdough")),
  uncoded.refusals.map((r) => r.reason).join(" | "));

const noContact = buildInvoice({ xero_contact_id: null, name: "IGA PADDINGTON" }, [
  line({ name: "Sourdough - White", sent: 2, unit_price: 5.0, xero_code: "SD-W" }),
]);
check("no Xero contact refuses rather than creating a duplicate customer",
  !noContact.ok, noContact.refusals.map((r) => r.reason).join(" | "));

const nothing = buildInvoice(STORE, [
  line({ name: "Cancelled", sent: 0, unit_price: 5.0, xero_code: "X" }),
]);
check("an empty standing order refuses", !nothing.ok);

check("a refusal never bills a partial invoice",
  unpriced.lines.length === 1 && unpriced.ok === false,
  "one line is billable, but ok is false — the caller must not send it");

console.log("\n— which week is being billed —\n");

/* Every case below runs under FOUR clocks, and that is the entire point.
 *
 * The version this replaces did the arithmetic on a Date parsed from a bare
 * "YYYY-MM-DDT00:00:00" -- midnight on the viewer's laptop -- and then read
 * it back with toISOString(), which is UTC. Under the CI runner's UTC clock
 * that is a no-op and every assertion below would have passed on the broken
 * code. Under Sydney's it was ten hours earlier, i.e. the day before.
 *
 * So the clock is part of the input. TZ is set before each call; Node 22
 * picks up a reassignment of process.env.TZ, which is checked first, because
 * a timezone test that silently fails to change the timezone is worse than
 * no test at all. */
const CLOCKS = ["UTC", "Australia/Sydney", "Pacific/Kiritimati", "Pacific/Midway"];
const TZ0 = process.env.TZ;
const under = <T,>(tz: string, f: () => T): T => {
  process.env.TZ = tz;
  try { return f(); } finally { process.env.TZ = TZ0; }
};

check("the harness can actually change the clock, or nothing below means anything",
  under("Australia/Sydney", () => new Date("2026-09-07T00:00:00").toISOString())
    !== under("UTC", () => new Date("2026-09-07T00:00:00").toISOString()),
  "if these match, process.env.TZ is being ignored and these cases prove nothing");

for (const tz of CLOCKS) {
  // Thursday 10 September 2026. The Monday of that week is the 7th, and it is
  // the 7th in Perth, in Kiritimati and in Samoa. A billing period is a
  // calendar fact about a business in Sydney, not a fact about a laptop.
  check(`Thursday resolves to its own Monday under ${tz}`,
    under(tz, () => weekStart("2026-09-10")) === "2026-09-07",
    under(tz, () => weekStart("2026-09-10")));
}

check("a Monday is its own week start",
  weekStart("2026-09-07") === "2026-09-07");
check("a Sunday belongs to the week that started six days earlier, not the next one",
  weekStart("2026-09-13") === "2026-09-07",
  "getDay() is 0 on Sunday; the naive subtraction sends it forward a week");
check("across a month boundary",
  weekStart("2026-10-01") === "2026-09-28");
check("across a year boundary",
  weekStart("2027-01-01") === "2026-12-28");
check("across the end of daylight saving in Sydney (5 April 2026, clocks go back)",
  weekStart("2026-04-05") === "2026-03-30",
  "the 5th is a Sunday and the day it falls on is 25 hours long in Sydney");
check("across the start of daylight saving in Sydney (4 October 2026, clocks go forward)",
  under("Australia/Sydney", () => weekStart("2026-10-04")) === "2026-09-28",
  "23-hour day; naive local arithmetic lands on the wrong side of it");

check("a value that is not a date refuses rather than inventing a week",
  (() => { try { weekStart("last monday"); return false; } catch { return true; } })());

console.log("\n— idempotency —\n");

/* THE REGRESSION THIS SECTION EXISTS FOR.
 *
 * idempotencyKey is the only thing standing between a customer and being
 * billed twice for one week: Xero dedupes on that header. It was being built
 * from a period start computed on the drafter's own clock, so Simona in
 * Sydney and anyone on a UTC machine produced two different keys for the same
 * store and the same week -- and Xero would have accepted both. */
const sydney = idempotencyKey("store-1", under("Australia/Sydney", () => weekStart("2026-09-10")));
const utc = idempotencyKey("store-1", under("UTC", () => weekStart("2026-09-10")));
check("two people on different clocks cannot each draft the same week",
  sydney === utc, `${sydney}  vs  ${utc}`);

const k1 = idempotencyKey("store-1", "2026-09-08");
const k2 = idempotencyKey("store-1", "2026-09-08");
const k3 = idempotencyKey("store-1", "2026-09-15");
check("the same customer and week gives the same key", k1 === k2, k1);
check("a different week gives a different key", k1 !== k3);
check("within Xero's 128 character limit", k1.length <= 128);

console.log(fails === 0 ? "\nAll cases pass." : `\n${fails} case(s) FAILED.`);
process.exit(fails === 0 ? 0 : 1);
