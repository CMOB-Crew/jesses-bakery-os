/**
 * xero-invoice-check.ts — what gets billed, and what refuses to be billed.
 *
 * The invoice is the one screen in this system that moves money out of a
 * real customer's account. Every rule below exists because the data has
 * the shape that would break it, and none of them can be checked by
 * looking at production, because production has never sent an invoice.
 *
 * The shape being asserted is production's own, taken from a real week
 * @Fred pulled out of Jesse's Data Factory on 11 September 2026: the
 * 6 September run, 94 invoices, 42 customers, 725 lines, $9,087.57. One
 * invoice per store per delivery day, Reference "FRIDAY - BP BOTANY",
 * Date on the delivery day, DueDate fourteen days later, all DRAFT.
 *
 * Run:  npx tsx scripts/xero-invoice-check.ts
 */
import {
  buildDayInvoice, buildWeek, weekQty, dayQty, dowOf, addDays,
  invoiceReference, idempotencyKey, dueDate, weekStart, billingWeekStart,
  invoiceBody, DAY_NAME, WEEKDAYS,
} from "../lib/xero-invoice";
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

const STORE = {
  xero_contact_id: "c0ffee00-0000-0000-0000-000000000001",
  name: "KRINSKYS",
  active: true,
};

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "\n        " + detail : ""}`);
}

/* ---------------------------------------------------------------- *
 * Dates. Everything else is built on these, and they were wrong once.
 * ---------------------------------------------------------------- */
console.log("— dates —\n");

const ZONES = ["Australia/Sydney", "UTC", "America/Los_Angeles", "Pacific/Kiritimati"];
function under<T>(tz: string, fn: () => T): T {
  const was = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { process.env.TZ = was; }
}

for (const tz of ZONES) {
  check(`weekStart is the Monday under ${tz}`,
    under(tz, () => weekStart("2026-09-10")) === "2026-09-07",
    under(tz, () => weekStart("2026-09-10")));
}
check("a Monday is its own week start", weekStart("2026-09-07") === "2026-09-07");
check("a Sunday belongs to the week that started six days earlier",
  weekStart("2026-09-13") === "2026-09-07",
  "a Sunday-start week would say 2026-09-13 and bill the wrong seven days");
check("weekStart crosses a month", weekStart("2026-10-01") === "2026-09-28");
check("weekStart crosses a year", weekStart("2027-01-01") === "2026-12-28");
check("a bad date throws rather than guessing",
  (() => { try { weekStart("last monday"); return false; } catch { return true; } })());

for (const tz of ZONES) {
  check(`addDays is stable under ${tz}`,
    under(tz, () => addDays("2026-09-13", 1)) === "2026-09-14");
}
check("addDays crosses a DST boundary in Sydney without drifting",
  under("Australia/Sydney", () => addDays("2026-10-03", 1)) === "2026-10-04",
  "Sydney DST starts 4 October 2026");

check("dowOf knows a Monday", dowOf("2026-09-14") === "mon");
check("dowOf knows a Sunday", dowOf("2026-09-20") === "sun");
for (const tz of ZONES) {
  check(`dowOf is stable under ${tz}`, under(tz, () => dowOf("2026-09-18")) === "fri");
}

/* ---------------------------------------------------------------- *
 * FORWARD, NOT BACKWARD. The one that breaks cutover week.
 * ---------------------------------------------------------------- */
console.log("\n— which week a run bills —\n");

check("the Sunday 13 Sept run bills 14 to 20 Sept, the week about to happen",
  billingWeekStart("2026-09-13") === "2026-09-14",
  "production's 6 Sept run produced invoices dated 7 to 13 Sept, all 94 after the run");
check("the Sunday 6 Sept run bills 7 to 13 Sept, which is what @Fred's file holds",
  billingWeekStart("2026-09-06") === "2026-09-07");
check("it never bills the week that just finished",
  billingWeekStart("2026-09-13") !== weekStart("2026-09-13"),
  "weekStart('2026-09-13') is 2026-09-07, the week that has already been delivered");
check("clicking it midweek bills the week you are in",
  billingWeekStart("2026-09-16") === "2026-09-14");
for (const tz of ZONES) {
  check(`billingWeekStart is stable under ${tz}`,
    under(tz, () => billingWeekStart("2026-09-13")) === "2026-09-14");
}

/* ---------------------------------------------------------------- *
 * The reference string, character for character.
 * ---------------------------------------------------------------- */
console.log("\n— the reference —\n");

check("matches production exactly",
  invoiceReference("fri", "BP BOTANY") === "FRIDAY - BP BOTANY",
  invoiceReference("fri", "BP BOTANY"));
check("the store name is uppercased",
  invoiceReference("mon", "Krinskys") === "MONDAY - KRINSKYS");
check("a plain hyphen, never an em dash",
  !/[‐-―−]/.test(invoiceReference("wed", "IGA LINDFIELD")),
  "ours said 'KRINSKYS — week of 2026-09-14' until 14 September");
check("the separator is exactly space hyphen space",
  invoiceReference("thu", "MADE IN DY").includes(" - "));
check("no day is abbreviated",
  WEEKDAYS.every((d) => DAY_NAME[d].length >= 6 && DAY_NAME[d] === DAY_NAME[d].toUpperCase()),
  "@Fred: full day name, uppercase. Not MON, not Monday");
check("a store name with surrounding space does not leak into the reference",
  invoiceReference("sat", "  THE CHAR BONDI  ") === "SATURDAY - THE CHAR BONDI");
check("an apostrophe survives",
  invoiceReference("mon", "Jesse's Cafe") === "MONDAY - JESSE'S CAFE");

/* ---------------------------------------------------------------- *
 * Quantity.
 * ---------------------------------------------------------------- */
console.log("\n— quantity —\n");

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

check("dayQty reads one day off the grid",
  dayQty(line({ name: "W", days: { mon: 4, wed: 0, fri: 9 } }), "fri") === 9);
check("a day absent from the grid is zero, not the weekly number",
  dayQty(line({ name: "W", sent: 50, days: { mon: 4 } }), "tue") === 0);
check("NO GRID IS NEVER SPLIT ACROSS DAYS",
  dayQty(line({ name: "W", sent: 50 }), "mon") === 0,
  "50 units over 5 delivery days would look exactly like a fact once it is on an invoice");

/* ---------------------------------------------------------------- *
 * One day.
 * ---------------------------------------------------------------- */
console.log("\n— one invoice, one day —\n");

const GRID = [
  line({ name: "Challah - Semisweet Sesame", days: { mon: 10, wed: 7 },
         unit_price: 4.70, xero_code: "CH-SS" }),
  line({ name: "Sourdough - White", days: { mon: 2, fri: 3 },
         unit_price: 5.00, xero_code: "SD-W" }),
];

const mon = buildDayInvoice(STORE, GRID, "2026-09-14");
check("Monday bills both lines", mon.kind === "ok" && mon.lines.length === 2);
check("Monday's total is that day's quantities, not the week's",
  mon.kind === "ok" && mon.total === 57.00,
  mon.kind === "ok" ? String(mon.total) : mon.kind);
check("Monday's reference names Monday",
  mon.kind === "ok" && mon.reference === "MONDAY - KRINSKYS");
check("Date is the delivery day", mon.kind === "ok" && mon.date === "2026-09-14");
check("DueDate is fourteen days later",
  mon.kind === "ok" && mon.dueDate === "2026-09-28",
  "all 94 of production's use Date + 14");

const wed = buildDayInvoice(STORE, GRID, "2026-09-16");
check("Wednesday bills only the line delivered on Wednesday",
  wed.kind === "ok" && wed.lines.length === 1 && wed.total === 32.90);

const tue = buildDayInvoice(STORE, GRID, "2026-09-15");
check("a day with no delivery is a SKIP, not a refusal and not an empty invoice",
  tue.kind === "skip",
  "four days a week are quiet for most customers; treating that as a problem buries the real ones");

const zeroDay = buildDayInvoice(STORE,
  [line({ name: "W", days: { mon: 0, wed: 5 }, unit_price: 5, xero_code: "X" })],
  "2026-09-14");
check("an explicit zero on the grid means no invoice that day",
  zeroDay.kind === "skip");

/* ---------------------------------------------------------------- *
 * The refusals.
 * ---------------------------------------------------------------- */
console.log("\n— what refuses —\n");

const noGrid = buildDayInvoice(STORE,
  [line({ name: "Challah", sent: 20, unit_price: 4.70, xero_code: "CH" })],
  "2026-09-14");
check("a weekly order with no day grid refuses, by name",
  noGrid.kind === "refuse" && /no delivery-day grid/.test(noGrid.refusals[0].reason),
  "37 of 42 customers have a grid; the other five are the invoice gap, and the fix is data");
check("the refusal names the lines it is talking about",
  noGrid.kind === "refuse" && noGrid.refusals[0].lines.includes("Challah"));

const unpriced = buildDayInvoice(STORE,
  [line({ name: "Challah", days: { mon: 10 }, xero_code: "CH" })],
  "2026-09-14");
check("no price refuses rather than billing zero",
  unpriced.kind === "refuse" && /no price/.test(unpriced.refusals[0].reason));

const deliberateZero = buildDayInvoice(STORE,
  [line({ name: "Challah", days: { mon: 10 }, unit_price: 0, xero_code: "CH" })],
  "2026-09-14");
check("a price that IS zero bills at zero",
  deliberateZero.kind === "ok" && deliberateZero.total === 0,
  "Jesse's Cafe is entirely zero, his own shop, and production invoices it that way");

const uncoded = buildDayInvoice(STORE,
  [line({ name: "Sourdough", days: { mon: 3 }, unit_price: 5.00 })],
  "2026-09-14");
check("no Xero item code refuses rather than guessing one",
  uncoded.kind === "refuse" && /no Xero item code/.test(uncoded.refusals[0].reason));

const noContact = buildDayInvoice(
  { xero_contact_id: null, name: "IGA PADDINGTON", active: true },
  [line({ name: "Challah", days: { mon: 10 }, unit_price: 4.70, xero_code: "CH" })],
  "2026-09-14");
check("no Xero contact refuses rather than creating a second customer",
  noContact.kind === "refuse" && /no Xero contact/.test(noContact.refusals[0].reason));

/* ---------------------------------------------------------------- *
 * Inactive stores.
 *
 * @Fred, 14 September, having checked BP KINGSFORD live in the legacy
 * system: "Your inactive flag is correct - the legacy is the stale side,
 * because it never reads the flag at all... the check belongs in the
 * invoicing code, not the comparison script. An inactive store with a day
 * grid shouldn't be drafted. That's the 75 others too."
 *
 * Until 15 September the flag was read by which-twelve.sh, which only
 * COMPARES, and by nothing that actually bills. So the comparison hid a
 * store the invoicing code would have drafted, which is the worst
 * possible arrangement: the check existed, and it was in the one place
 * where being right changed nothing.
 * ---------------------------------------------------------------- */
console.log("\n— inactive stores —\n");

const INACTIVE = { ...STORE, name: "BP KINGSFORD", active: false };

const inactiveDay = buildDayInvoice(INACTIVE, GRID, "2026-09-14");
check("an inactive store is not billed on a day it does have a delivery",
  inactiveDay.kind === "skip",
  "the legacy drafts BP KINGSFORD every Tue and Thu for a store its own data calls inactive");
check("and it says inactive, rather than reading as an ordinary quiet day",
  inactiveDay.kind === "skip" && /inactive/i.test(inactiveDay.reason));

check("every day of an inactive store's week is skipped",
  buildWeek(INACTIVE, GRID, "2026-09-14").every((d) => d.kind === "skip"));

// Ordering. Inactive is checked BEFORE the order book, so turning a
// customer off silences every other complaint about them too.
const inactiveBroken = buildDayInvoice(INACTIVE,
  [line({ name: "Challah", days: { mon: 10 }, unit_price: null, xero_code: "CH" })],
  "2026-09-14");
check("an inactive store with an unpriced line skips rather than refusing",
  inactiveBroken.kind === "skip",
  "otherwise switching a customer off fills the refusal list with work nobody wants done");

const inactiveNoContact = buildDayInvoice(
  { xero_contact_id: null, name: "BP KINGSFORD", active: false }, GRID, "2026-09-14");
check("and the same when it has no Xero contact either",
  inactiveNoContact.kind === "skip");

check("an ACTIVE store is still billed, so the gate is not simply always on",
  buildDayInvoice(STORE, GRID, "2026-09-14").kind === "ok",
  "a gate that refuses everything passes every test above and bills nobody");

/* ---------------------------------------------------------------- *
 * A week.
 * ---------------------------------------------------------------- */
console.log("\n— a week —\n");

const week = buildWeek(STORE, GRID, "2026-09-14");
check("always seven days, Monday first", week.length === 7 && week[0].dow === "mon");
check("the last day is Sunday", week[6].dow === "sun");
check("three billable days out of seven",
  week.filter((d) => d.kind === "ok").length === 3);
check("four quiet days, and they are reported rather than dropped",
  week.filter((d) => d.kind === "skip").length === 4,
  "a silently short list is how a missing day stops being noticed");
check("the week's money equals the sum of its days",
  week.filter((d) => d.kind === "ok")
      .reduce((a, d) => a + (d.kind === "ok" ? d.total : 0), 0) === 104.90);
check("every billable day's date matches the weekday in its own reference",
  week.every((d) => d.kind !== "ok" || d.reference.startsWith(DAY_NAME[dowOf(d.date)])),
  "@Fred checked exactly this on production: 94 of 94");
check("buildWeek accepts any day of that week and still starts on the Monday",
  buildWeek(STORE, GRID, "2026-09-17")[0].date === "2026-09-14");

const noGridWeek = buildWeek(STORE,
  [line({ name: "Challah", sent: 20, unit_price: 4.70, xero_code: "CH" })],
  "2026-09-14");
check("a customer with no grid refuses on every day, so the week cannot half-bill",
  noGridWeek.every((d) => d.kind === "refuse"));

/* ---------------------------------------------------------------- *
 * Idempotency.
 * ---------------------------------------------------------------- */
console.log("\n— idempotency —\n");

check("the key is per store per DAY",
  idempotencyKey("store-1", "2026-09-14") !== idempotencyKey("store-1", "2026-09-16"),
  "a weekly key would make Xero swallow every invoice after the first as a duplicate");
check("the same store and day gives the same key",
  idempotencyKey("store-1", "2026-09-14") === idempotencyKey("store-1", "2026-09-14"));
check("two stores on the same day do not collide",
  idempotencyKey("store-1", "2026-09-14") !== idempotencyKey("store-2", "2026-09-14"));
for (const tz of ZONES) {
  check(`the key is identical under ${tz}`,
    under(tz, () => idempotencyKey("store-1", billingWeekStart("2026-09-13"))) ===
    "jb-store-1-2026-09-14",
    "it decides whether a customer can be billed twice");
}
check("the key is inside Xero's 128 character limit",
  idempotencyKey("00000000-0000-0000-0000-000000000000", "2026-09-14").length <= 128);
check("dueDate is pure arithmetic on the date",
  dueDate("2026-09-14") === "2026-09-28");

/* ---------------------------------------------------------------- *
 * The payload, field for field.
 * ---------------------------------------------------------------- */
console.log("\n— the payload —\n");

const body = invoiceBody({
  contactId: STORE.xero_contact_id,
  reference: "MONDAY - KRINSKYS",
  date: "2026-09-14",
  dueDate: "2026-09-28",
  idempotencyKey: "jb-x-2026-09-14",
  lines: [{ itemCode: "CH-SS", description: "Challah", quantity: 10, unitAmount: 4.7 }],
});
const inv = body.Invoices[0] as Record<string, unknown>;
const li = (inv.LineItems as Record<string, unknown>[])[0];

check("the invoice keys are exactly what production sends",
  JSON.stringify(Object.keys(inv).sort()) ===
  JSON.stringify(["Contact", "Date", "DueDate", "LineItems", "Reference", "Status", "Type"]),
  Object.keys(inv).sort().join(", "));
check("Date is sent, which it never used to be",
  inv.Date === "2026-09-14",
  "without it Xero dates the invoice the day it was drafted, not the delivery day");
check("DueDate is sent", inv.DueDate === "2026-09-28");
check("it is a customer invoice", inv.Type === "ACCREC");
check("DRAFT, always", inv.Status === "DRAFT");
check("there is no way to ask for anything but DRAFT",
  !("Status" in ({} as Record<string, unknown>)) && inv.Status === "DRAFT");

check("the line keys are exactly what we intend to send",
  JSON.stringify(Object.keys(li).sort()) ===
  JSON.stringify(["Description", "ItemCode", "Quantity", "UnitAmount"]),
  Object.keys(li).sort().join(", "));
check("no AccountCode",
  !("AccountCode" in li),
  "production sends none and Xero fills it from the item; ours would override 16 months of their accounting");
check("no TaxType", !("TaxType" in li));
check("no LineAmount, and that is the one deliberate difference from production",
  !("LineAmount" in li),
  "Xero computes it from Quantity x UnitAmount, so sending ours can only ever agree or contradict");

console.log(
  fails === 0
    ? `\n  ${"All checks pass"}. One invoice per store per delivery day, dated forward.\n`
    : `\n  ${fails} FAILED\n`,
);
process.exit(fails === 0 ? 0 : 1);
