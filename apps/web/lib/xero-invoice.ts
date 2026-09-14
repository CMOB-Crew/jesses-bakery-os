/* ------------------------------------------------------------------ *
 * Turning a customer's standing order into Xero invoice lines.
 *
 * Pure on purpose. No database, no network, no React -- so the part that
 * decides what a customer gets billed can be asserted in a script rather
 * than discovered on a real invoice sent to a real business.
 *
 * ONE INVOICE PER STORE PER DELIVERY DAY. NOT PER WEEK.
 *
 * This module billed a week at a time until 14 September 2026. That was
 * wrong, and it was wrong in four ways at once. @Fred pulled a real week
 * out of Jesse's Data Factory -- the 6 September run, 94 invoices, 42
 * customers, 725 lines, $9,087.57 -- and the shape it has been sending
 * since May 2025 is:
 *
 *   ours, before                      production, since May 2025
 *   one invoice per customer/WEEK     one per customer per DELIVERY DAY
 *   "KRINSKYS — week of 2026-09-14"   "MONDAY - KRINSKYS"
 *     ^ em dash                         ^ plain hyphen, uppercase
 *   no Date field sent at all         Date = the delivery day
 *   (no DueDate)                      DueDate = Date + 14
 *   billed BACKWARD                   billed FORWARD, the coming week
 *
 * The last one is the dangerous one. Production drafts the week that is
 * about to happen: the Sunday 6 September run produced invoices dated
 * 7 to 13 September, and every invoice's Date matches the weekday in its
 * own Reference, 94 times out of 94. If ours billed backward, the first
 * week we cut over would either bill a week twice or skip one entirely,
 * against customers who are already being invoiced.
 *
 * WHY A CUSTOMER WITHOUT A DAY GRID CANNOT BE BILLED THIS WAY
 *
 * A per-day invoice needs a per-day quantity. That lives in
 * store_product_days, loaded on 7 September from Jesse's own standing
 * order book -- 1,007 rows, 273 lines, 37 customers. A customer without
 * one has a weekly total and nothing that says how it splits, and
 * spreading it across their delivery days would be an invention that
 * looks exactly like a fact once it is on an invoice.
 *
 * So it refuses, by name. Measured on the live database on 14 September:
 * 37 customers can be billed per day and would produce 82 invoices;
 * production produced 94. The gap is customers with no grid, seven of
 * which are the seven that failed to load on 7 September because Jesse's
 * order book and Simona's Stores Master disagree about their delivery
 * days. That is a data question with a known answer, not a code problem.
 *
 * THE THREE REFUSALS
 *
 * Every one of these came out of the data, not out of caution:
 *
 *   1. NO PRICE IS NOT A FREE LINE. Two thirds of the legacy price list
 *      was 0.00 and none of it was carried across, so a missing price
 *      means nobody has ever said what this customer pays. Billing it at
 *      zero would look like a decision. (A price that IS deliberately
 *      zero is a different thing and bills fine -- Jesse's Cafe is
 *      entirely zero, his own shop, and production invoices it that way.)
 *   2. NO XERO CODE IS NOT A GUESS. Five lines are priced with no code --
 *      Oasis Olympic Park's sourdoughs, where the old system had the
 *      store's own name in the code column. An invoice cannot invent it.
 *   3. NO CONTACT IS NOT A NEW CONTACT. 72 of 73 customers have a Xero
 *      contact id. Creating one from our side would make a duplicate
 *      customer in their books.
 *
 * A refusal names the lines. It never bills a partial invoice and calls
 * it done, and it never silently drops a line -- the two ways this could
 * quietly cost Jesse money. A refusal on ANY day stops the WHOLE week,
 * for the same reason: a customer billed for Monday and Wednesday but
 * not Friday has been quietly under-billed.
 * ------------------------------------------------------------------ */

import type { StandingLine } from "@/lib/queries";

export type XeroLine = {
  productId: string;
  description: string;
  itemCode: string;
  quantity: number;
  unitAmount: number;
  lineTotal: number;
};

export type InvoiceRefusal = { reason: string; lines: string[] };

/** The seven, in the order Postgres' `weekday` enum declares them. */
export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * How the day is spelled on the invoice.
 *
 * @Fred, off the file: "Full day name, uppercase, space hyphen space,
 * store name uppercase as it appears in Stores_Master. All 94 follow it,
 * no exceptions." Not MON, not Monday. MONDAY.
 */
export const DAY_NAME: Record<Weekday, string> = {
  mon: "MONDAY",
  tue: "TUESDAY",
  wed: "WEDNESDAY",
  thu: "THURSDAY",
  fri: "FRIDAY",
  sat: "SATURDAY",
  sun: "SUNDAY",
};

/** Money, to the cent. Xero accepts 2dp on a unit price by default. */
const cents = (n: number) => Math.round(n * 100) / 100;

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

function utcOf(ymd: string, who: string): Date {
  const m = YMD.exec(ymd);
  if (!m) throw new Error(`${who}: expected YYYY-MM-DD, got ${JSON.stringify(ymd)}`);
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) throw new Error(`${who}: not a real date: ${ymd}`);
  return d;
}

/**
 * Date arithmetic that gives the same answer on every machine on earth.
 *
 * Everything here goes through Date.UTC and stays in UTC. The reasoning
 * is under weekStart at the bottom of this file and it is not academic:
 * the same four lines of "ordinary" local-time arithmetic silently
 * returned a different day in Sydney than in UTC, and the invoice's
 * idempotency key is built from a date.
 */
export function addDays(ymd: string, n: number): string {
  const d = utcOf(ymd, "addDays");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Which weekday a date falls on. getUTCDay: 0 = Sunday. */
export function dowOf(ymd: string): Weekday {
  const d = utcOf(ymd, "dowOf");
  return WEEKDAYS[(d.getUTCDay() + 6) % 7];
}

/**
 * The quantity this line is delivered on ONE weekday.
 *
 * No day grid means no answer, and 0 is the only honest one. It is never
 * "the weekly number divided by the delivery days" -- that would put a
 * number on an invoice that nobody at Jesse's ever agreed to.
 * buildDayInvoice turns a customer in that state into a named refusal
 * rather than letting these zeroes quietly produce an empty week.
 */
export function dayQty(l: StandingLine, dow: Weekday): number {
  if (!l.days) return 0;
  return Number(l.days[dow]) || 0;
}

/**
 * A week's quantity for one line.
 *
 * NOT the same as the store profile's `effective()`, which is
 * `override_qty ?? sent` and ignores the day grid. Migration 074 is
 * explicit that a line with any row in store_product_days is defined by
 * that grid for every day -- the engine plan, the weekly override and
 * last week's carry-forward are all suppressed for it. So for those lines
 * the week is the sum of the days, and reading the weekly number instead
 * would bill something the customer is not receiving.
 *
 * This used to carry a note saying store_product_days was empty in
 * production so both rules agreed. That stopped being true on 7 September
 * 2026, when the day grid was loaded from the legacy order book. It is
 * now the rule that governs 37 customers and 1,007 rows.
 */
export function weekQty(l: StandingLine): number {
  if (l.days) {
    return WEEKDAYS.reduce((a, d) => a + (Number(l.days?.[d]) || 0), 0);
  }
  return l.override_qty != null ? l.override_qty : l.sent;
}

/** `FRIDAY - BP BOTANY`. A plain hyphen. Never an em dash. */
export function invoiceReference(dow: Weekday, storeName: string): string {
  return `${DAY_NAME[dow]} - ${storeName.trim().toUpperCase()}`;
}

/**
 * The idempotency key for one customer's invoice for one DAY.
 *
 * It used to be keyed on the week. Per-day invoices mean a customer can
 * legitimately receive several invoices for the same week, so a weekly
 * key would make Xero swallow every one after the first as a duplicate.
 *
 * Deterministic on purpose. Xero dedupes on this header, so a retry after
 * a timeout -- the case where you cannot tell whether the first call
 * landed -- cannot produce a second invoice for the same store and day.
 * A random key would defeat the entire mechanism.
 *
 * 128 characters is Xero's limit; this is nowhere near it.
 */
export function idempotencyKey(storeId: string, date: string): string {
  return `jb-${storeId}-${date}`;
}

/** Fourteen days, which is what production has used on all 94. */
export function dueDate(date: string): string {
  return addDays(date, 14);
}

export type DayInvoice =
  /** Nothing is delivered to this customer on this day. Not a problem. */
  | { kind: "skip"; date: string; dow: Weekday; reason: string }
  /** Something needs fixing before this customer can be billed at all. */
  | { kind: "refuse"; date: string; dow: Weekday; refusals: InvoiceRefusal[] }
  | {
      kind: "ok";
      date: string;
      dow: Weekday;
      dueDate: string;
      reference: string;
      contactId: string;
      lines: XeroLine[];
      total: number;
    };

/**
 * One invoice, one customer, one delivery day.
 *
 * The three states are deliberately distinct. A store that simply does
 * not get a delivery on Tuesday must produce NOTHING -- silently, with no
 * warning and no empty invoice -- because that is the normal case for
 * every customer on four days of the week. Treating it as a refusal would
 * bury the real refusals in noise.
 */
export function buildDayInvoice(
  store: { xero_contact_id: string | null; name: string; active: boolean },
  lines: StandingLine[],
  date: string,
): DayInvoice {
  const dow = dowOf(date);
  const refusals: InvoiceRefusal[] = [];

  // AN INACTIVE STORE IS NOT BILLED, ON ANY DAY, WHATEVER ITS ORDER BOOK
  // SAYS.
  //
  // This is the first thing checked, before the order book is looked at
  // at all, and it is a SKIP rather than a refusal. Both of those are
  // deliberate.
  //
  // A refusal means "fix this and it will bill". There is nothing to fix.
  // Somebody turned this customer off on purpose, and putting it in the
  // refusal list would ask a person to undo a decision they meant to
  // make -- while burying the refusals that are real.
  //
  // Checked FIRST so that turning a customer off also silences every
  // other complaint about them. An inactive store with an unpriced line
  // is not a pricing problem anybody needs to hear about.
  //
  // @Fred, 14 September, having checked BP KINGSFORD live against the
  // legacy system: "Your inactive flag is correct - the legacy is the
  // stale side, because it never reads the flag at all... An inactive
  // store with a day grid shouldn't be drafted. That's the 75 others
  // too."
  //
  // So the legacy system drafts invoices for stores its own master data
  // says are inactive, and did it again on 13 September. We do not. That
  // is a DELIBERATE difference from production, and it is the reason a
  // diff against production will never reach zero.
  if (!store.active) {
    return {
      kind: "skip",
      date,
      dow,
      reason: `${store.name} is marked inactive, so it is not invoiced.`,
    };
  }

  // A customer whose order book has no day grid at all. Distinguish this
  // from "nothing on Tuesday": the first cannot be billed per day at all,
  // the second is an ordinary quiet day.
  const anyOrdered = lines.filter((l) => weekQty(l) > 0);
  const hasGrid = anyOrdered.some((l) => l.days != null);

  if (anyOrdered.length > 0 && !hasGrid) {
    refusals.push({
      reason:
        `${store.name} has a weekly order but no delivery-day grid, and a week cannot be ` +
        `split across days without inventing the split. Set the day grid on these lines ` +
        `and this will bill them.`,
      lines: anyOrdered.map((l) => l.name),
    });
  }

  // Only lines this customer actually gets on THIS day. A zero on the
  // grid is a real instruction -- do not deliver -- not a missing number.
  const today = lines.filter((l) => dayQty(l, dow) > 0);

  if (refusals.length === 0 && today.length === 0) {
    return {
      kind: "skip",
      date,
      dow,
      reason: `${store.name} has no delivery on ${DAY_NAME[dow].toLowerCase()}.`,
    };
  }

  const noPrice = today.filter((l) => l.unit_price == null);
  const noCode = today.filter((l) => l.unit_price != null && !l.xero_code);

  if (!store.xero_contact_id) {
    refusals.push({
      reason:
        `${store.name} has no Xero contact on file. Link it to the customer that already ` +
        `exists in Xero rather than letting this create a second one.`,
      lines: [],
    });
  }
  if (noPrice.length) {
    refusals.push({
      reason:
        `${noPrice.length} ${noPrice.length === 1 ? "line has" : "lines have"} no price for this ` +
        `customer. No price is not a free line — set the price and this will bill it.`,
      lines: noPrice.map((l) => l.name),
    });
  }
  if (noCode.length) {
    refusals.push({
      reason:
        `${noCode.length} ${noCode.length === 1 ? "line has" : "lines have"} no Xero item code for ` +
        `this customer, so there is nothing to bill it as. It cannot be guessed.`,
      lines: noCode.map((l) => l.name),
    });
  }

  if (refusals.length) return { kind: "refuse", date, dow, refusals };

  const xeroLines: XeroLine[] = today.map((l) => {
    const quantity = dayQty(l, dow);
    const unitAmount = cents(l.unit_price as number);
    return {
      productId: l.product_id,
      description: l.name,
      itemCode: l.xero_code as string,
      quantity,
      unitAmount,
      lineTotal: cents(quantity * unitAmount),
    };
  });

  return {
    kind: "ok",
    date,
    dow,
    dueDate: dueDate(date),
    reference: invoiceReference(dow, store.name),
    contactId: store.xero_contact_id as string,
    lines: xeroLines,
    total: cents(xeroLines.reduce((a, l) => a + l.lineTotal, 0)),
  };
}

/**
 * A customer's whole week: seven results, Monday first, always seven.
 *
 * Returning the skips rather than filtering them out is deliberate. The
 * caller has to be able to say "Tuesday and Thursday, nothing on the
 * other five" without re-deriving it, and a silently short list is how a
 * missing day stops being noticed.
 */
export function buildWeek(
  store: { xero_contact_id: string | null; name: string; active: boolean },
  lines: StandingLine[],
  weekStartYmd: string,
): DayInvoice[] {
  const mon = weekStart(weekStartYmd);
  return WEEKDAYS.map((_, i) => buildDayInvoice(store, lines, addDays(mon, i)));
}

export type XeroInvoiceInput = {
  contactId: string;
  reference: string;
  /** The delivery day. Production sets this on all 94 and so must we. */
  date: string;
  dueDate: string;
  idempotencyKey: string;
  lines: { itemCode: string; description: string; quantity: number; unitAmount: number }[];
};

/**
 * The request body, on its own so it can be checked without a network call.
 *
 * It is pinned field for field against a real invoice the legacy system sent,
 * because the thing that matters here is not that Xero accepts the payload --
 * it would accept several wrong ones -- but that these customers keep getting
 * the invoice they have had since May 2025.
 *
 * WHAT PRODUCTION SENDS, PER @FRED'S FILE, AND NOTHING ELSE:
 *
 *   Type, Contact.ContactID, Date, DueDate, Reference, Status
 *   LineItems[]: Description, Quantity, UnitAmount, ItemCode, LineAmount
 *
 * No AccountCode and no TaxType. Deliberate: production sends neither and
 * Xero fills both from the item, so sending ours would override sixteen
 * months of the customer's own accounting. It also makes the ItemCode
 * lookup load-bearing -- a stale code is a FAILED LINE, not a cosmetic
 * problem.
 *
 * NO LineAmount EITHER, AND THAT IS THE ONE DELIBERATE DIFFERENCE.
 * Production sends it; we do not. LineAmount is Quantity x UnitAmount and
 * Xero computes it regardless, so sending it can only ever agree with
 * Xero or contradict it. A rounding disagreement between our arithmetic
 * and theirs would be a rejected line for no gain. Recorded here rather
 * than left to be discovered, because "we match production field for
 * field" is otherwise true.
 *
 * See scripts/xero-invoice-check.ts, which asserts the exact key set.
 */
export function invoiceBody(input: XeroInvoiceInput) {
  return {
    Invoices: [
      {
        Type: "ACCREC",
        Status: "DRAFT",
        Contact: { ContactID: input.contactId },
        Date: input.date,
        DueDate: input.dueDate,
        Reference: input.reference,
        LineItems: input.lines.map((l) => ({
          ItemCode: l.itemCode,
          Description: l.description,
          Quantity: l.quantity,
          UnitAmount: l.unitAmount,
        })),
      },
    ],
  };
}


/* ------------------------------------------------------------------ *
 * WHICH WEEK IS BEING BILLED.
 *
 * This moved here on 10 September 2026 because it was wrong, and because
 * it belongs beside the rules it feeds. The header of this file says every
 * rule about what gets billed lives in this module. The period an invoice
 * covers is one of those rules, and it was being decided in a browser
 * component -- four lines that looked like ordinary date arithmetic:
 *
 *   const d = new Date(`${today}T00:00:00`);          // the BROWSER'S zone
 *   d.setDate(d.getDate() - ((d.getDay() + 6) % 7));  // the browser's clock
 *   return d.toISOString().slice(0, 10);              // read back in UTC
 *
 * A bare "YYYY-MM-DDT00:00:00" carries no zone, so it is midnight on the
 * viewer's laptop. toISOString() then reads that same instant in UTC. In
 * Sydney that is ten hours earlier -- the day before -- so periodStart was
 * always the SUNDAY of the week it claimed to be the Monday of.
 *
 *   today = 2026-09-10  ->  2026-09-06     the Monday is 2026-09-07
 *
 * Measured, not reasoned: run the old four lines under TZ=Australia/Sydney
 * and TZ=UTC and they disagree. Two things followed, and the second is
 * much worse than the first.
 *
 *   1. The reference on the invoice Simona sends a customer named the
 *      wrong week.
 *   2. idempotencyKey() is built from it. Xero dedupes on that header, so
 *      it is the one thing standing between a customer and being billed
 *      twice -- and it was returning a different answer depending on which
 *      laptop drafted the invoice. Sydney and UTC would each happily
 *      create their own draft for the same store and period.
 *
 * The fix is to never let a local clock into it. Date.UTC fixes the
 * instant, every step after it is UTC, so the answer is identical on every
 * machine on earth. That is asserted under four timezones in
 * scripts/xero-invoice-check.ts, because a test that runs only under the
 * runner's UTC clock would have passed on the broken version.
 * ------------------------------------------------------------------ */
export function weekStart(ymd: string): string {
  const d = utcOf(ymd, "weekStart");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // getUTCDay: 0 = Sunday
  return d.toISOString().slice(0, 10);
}

/**
 * WHICH WEEK A RUN ON THIS DATE SHOULD BILL. FORWARD, NOT BACKWARD.
 *
 * Production runs Load_Standing_Orders_Weekly_Schedule at 09:00 on a
 * Sunday and drafts the week that is about to start: the 6 September run
 * produced invoices dated 7 to 13 September, all 94 of them dated after
 * the run itself.
 *
 *   weekStart(runDate + 1 day)
 *
 * Sunday 13 Sept -> Monday 14 -> the week of 14 to 20. Which is exactly
 * what production drafted, and what is sitting in Jesse's Xero now.
 *
 * Run on any weekday it gives that same week, which is the sensible
 * answer for a person clicking the button on a Wednesday. It is NOT
 * designed for a Saturday run -- that would bill a week with one day left
 * in it -- but nothing runs on a Saturday and pretending to handle it
 * would only hide the assumption.
 */
export function billingWeekStart(runDate: string): string {
  return weekStart(addDays(runDate, 1));
}
