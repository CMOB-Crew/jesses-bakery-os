/* ------------------------------------------------------------------ *
 * Turning a customer's standing order into Xero invoice lines.
 *
 * Pure on purpose. No database, no network, no React -- so the part that
 * decides what a customer gets billed can be asserted in a script rather
 * than discovered on a real invoice sent to a real business.
 *
 * WHAT AN INVOICE IS HERE
 *
 * Invoice customers are not forecast. Simona, 1 September: "they order,
 * they get an invoice, and they pay for what they order." The standing
 * order on the store profile IS that order, and every line already
 * carries this customer's own price and this customer's own Xero item
 * code -- the same product bills as a different Xero item for different
 * customers, which is why xero_code sits on store_product_prices and not
 * on products.
 *
 * THE THREE REFUSALS
 *
 * Every one of these came out of the data, not out of caution:
 *
 *   1. NO PRICE IS NOT A FREE LINE. Two thirds of the legacy price list
 *      was 0.00 and none of it was carried across, so a missing price
 *      means nobody has ever said what this customer pays. Billing it at
 *      zero would look like a decision.
 *   2. NO XERO CODE IS NOT A GUESS. Five lines are priced with no code --
 *      Oasis Olympic Park's sourdoughs, where the old system had the
 *      store's own name in the code column. An invoice cannot invent it.
 *   3. NO CONTACT IS NOT A NEW CONTACT. 72 of 73 customers have a Xero
 *      contact id. Creating one from our side would make a duplicate
 *      customer in their books.
 *
 * A refusal names the lines. It never bills a partial invoice and calls
 * it done, and it never silently drops a line -- the two ways this could
 * quietly cost Jesse money.
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

export type InvoiceDraft = {
  contactId: string;
  lines: XeroLine[];
  total: number;
  /** Everything that stopped a line, or stopped the whole invoice. */
  refusals: InvoiceRefusal[];
  /** True only when there is at least one line and nothing was refused. */
  ok: boolean;
};

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
 * It does not matter yet: store_product_days is empty in production, so
 * both rules agree today. It will matter the first time Simona sets a day
 * grid, and an invoice is the wrong place to find that out.
 */
export function weekQty(l: StandingLine): number {
  if (l.days) {
    return Object.values(l.days).reduce((a, n) => a + (Number(n) || 0), 0);
  }
  return l.override_qty != null ? l.override_qty : l.sent;
}

/** Money, to the cent. Xero accepts 2dp on a unit price by default. */
const cents = (n: number) => Math.round(n * 100) / 100;

export function buildInvoice(
  store: { xero_contact_id: string | null; name: string },
  lines: StandingLine[],
): InvoiceDraft {
  const refusals: InvoiceRefusal[] = [];

  // Only lines this customer is actually getting. A zero is a real
  // instruction -- do not deliver -- and does not belong on an invoice.
  const ordered = lines.filter((l) => weekQty(l) > 0);

  const noPrice = ordered.filter((l) => l.unit_price == null);
  const noCode = ordered.filter((l) => l.unit_price != null && !l.xero_code);

  if (!store.xero_contact_id) {
    refusals.push({
      reason:
        `${store.name} has no Xero contact on file. Link it to the customer that already ` +
        `exists in Xero rather than letting this create a second one.`,
      lines: [],
    });
  }
  if (ordered.length === 0) {
    refusals.push({
      reason: "There is nothing on this customer's standing order to bill.",
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

  const good = ordered.filter((l) => l.unit_price != null && l.xero_code);
  const xeroLines: XeroLine[] = good.map((l) => {
    const quantity = weekQty(l);
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
    contactId: store.xero_contact_id ?? "",
    lines: xeroLines,
    total: cents(xeroLines.reduce((a, l) => a + l.lineTotal, 0)),
    refusals,
    ok: refusals.length === 0 && xeroLines.length > 0,
  };
}

/**
 * The idempotency key for one customer's invoice for one period.
 *
 * Deterministic on purpose. Xero dedupes on this header, so a retry after
 * a timeout -- the case where you cannot tell whether the first call
 * landed -- cannot produce a second invoice for the same week. A random
 * key would defeat the entire mechanism.
 *
 * 128 characters is Xero's limit; this is nowhere near it.
 */
export function idempotencyKey(storeId: string, periodStart: string): string {
  return `jb-${storeId}-${periodStart}`;
}
