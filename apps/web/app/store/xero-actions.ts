"use server";

import { withUser } from "@/lib/db";
import { getStoreIsActive, getStoreStandingOrder } from "@/lib/queries";
import {
  buildWeek, idempotencyKey, type DayInvoice, type InvoiceRefusal,
} from "@/lib/xero-invoice";
import {
  xeroConfig, xeroNotReady, xeroToken, xeroTenantId, createDraftInvoice, XeroError,
} from "@/lib/xero";

/* ------------------------------------------------------------------ *
 * Draft a customer's invoices for one week. ONE PER DELIVERY DAY.
 *
 * DRAFTS. Never authorised, never sent. Simona opens them in Xero,
 * checks them and sends them -- which is what production does too: all
 * 94 invoices in the week @Fred pulled were posted as DRAFT.
 *
 * WHY THE WHOLE WEEK STOPS IF ONE DAY REFUSES
 *
 * A customer billed for Monday and Wednesday but not Friday, because
 * Friday had a line with no price, has been quietly under-billed and
 * nothing on the invoice says so. So every day is built and checked
 * BEFORE anything is sent, and one refusal anywhere stops all of them.
 * Partial billing is the failure this module exists to prevent.
 *
 * WHY IT IS NOT ONE TRANSACTION
 *
 * It cannot be -- Xero has no batch that is atomic across invoices. So
 * the ordering matters: validate everything, then send. If the network
 * dies halfway, some drafts exist and some do not, and re-running is
 * safe because the idempotency key is per store per DAY. Xero swallows
 * the ones that already landed and creates the rest.
 *
 * Everything that decides WHAT is billed lives in lib/xero-invoice.ts and
 * is asserted in scripts/xero-invoice-check.ts. This file only fetches,
 * validates, calls and reports.
 * ------------------------------------------------------------------ */

export type DayOutcome =
  | { date: string; day: string; kind: "skip" }
  | { date: string; day: string; kind: "created";
      reference: string; invoiceNumber: string | null; total: number | null;
      url: string; lines: number }
  | { date: string; day: string; kind: "failed"; error: string };

export type DraftWeekResult =
  | { ok: true; weekStart: string; days: DayOutcome[]; created: number; total: number }
  | { ok: false; weekStart: string; error: string; refusals?: InvoiceRefusal[] };

const DAY_LABEL = (d: DayInvoice) => d.dow;

export async function draftXeroWeek(input: {
  storeId: string;
  storeName: string;
  xeroContactId: string | null;
  /** Monday of the week being billed, YYYY-MM-DD. From billingWeekStart. */
  weekStart: string;
}): Promise<DraftWeekResult> {
  const cfg = xeroConfig();
  const notReady = xeroNotReady(cfg);
  if (notReady || !cfg) {
    return { ok: false, weekStart: input.weekStart, error: notReady ?? "Xero is not connected." };
  }

  let lines;
  try {
    lines = await withUser(() => getStoreStandingOrder(input.storeId));
  } catch {
    return {
      ok: false,
      weekStart: input.weekStart,
      error: "Could not read this customer's standing order. Nothing has been sent.",
    };
  }

  // The active flag is read HERE, from the database, and not taken from
  // the caller. storeName and xeroContactId arrive from the browser
  // because one is cosmetic and the other is checked by Xero. Whether a
  // customer gets billed at all is not in that category.
  let active: boolean | null;
  try {
    active = await withUser(() => getStoreIsActive(input.storeId));
  } catch {
    return {
      ok: false,
      weekStart: input.weekStart,
      error: "Could not read this customer's record, so nothing has been sent.",
    };
  }
  if (active === null) {
    return {
      ok: false,
      weekStart: input.weekStart,
      error: `${input.storeName} is not in the store list, so there is nothing to bill.`,
    };
  }
  if (!active) {
    // buildWeek would skip every day and the message below would then say
    // "no deliveries this week", which is both wrong and the sort of wrong
    // that sends somebody looking at the order book. Say the real reason.
    return {
      ok: false,
      weekStart: input.weekStart,
      error:
        `${input.storeName} is marked inactive, so it is not invoiced. Nothing has been ` +
        `sent. If this customer should be billed, make the store active first.`,
    };
  }

  const week = buildWeek(
    { xero_contact_id: input.xeroContactId, name: input.storeName, active },
    lines,
    input.weekStart,
  );

  // Every refusal across the whole week, de-duplicated -- the same
  // unpriced line will refuse on every day it is delivered, and saying so
  // five times is noise.
  const seen = new Set<string>();
  const refusals: InvoiceRefusal[] = [];
  for (const d of week) {
    if (d.kind !== "refuse") continue;
    for (const r of d.refusals) {
      const key = r.reason + "|" + r.lines.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      refusals.push(r);
    }
  }
  if (refusals.length) {
    return {
      ok: false,
      weekStart: input.weekStart,
      error: `Nothing has been sent to Xero. ${refusals.length === 1 ? "One thing" : `${refusals.length} things`} need fixing first.`,
      refusals,
    };
  }

  const billable = week.filter((d): d is Extract<DayInvoice, { kind: "ok" }> => d.kind === "ok");
  if (billable.length === 0) {
    return {
      ok: false,
      weekStart: input.weekStart,
      error: `${input.storeName} has no deliveries in the week of ${input.weekStart}, so there is nothing to bill.`,
    };
  }

  // Validation is done. Only now does anything leave the building.
  let token: string;
  let tenantId: string;
  try {
    token = await xeroToken(cfg);
    tenantId = await xeroTenantId(token);
  } catch (e) {
    const msg =
      e instanceof XeroError ? e.message
      : e instanceof Error ? e.message
      : "Xero could not be reached.";
    return { ok: false, weekStart: input.weekStart, error: msg };
  }

  const days: DayOutcome[] = [];
  let created = 0;
  let total = 0;

  for (const d of week) {
    if (d.kind === "skip") {
      days.push({ date: d.date, day: DAY_LABEL(d), kind: "skip" });
      continue;
    }
    if (d.kind !== "ok") continue; // unreachable: refusals returned above
    try {
      const res = await createDraftInvoice(token, tenantId, {
        contactId: d.contactId,
        reference: d.reference,
        date: d.date,
        dueDate: d.dueDate,
        idempotencyKey: idempotencyKey(input.storeId, d.date),
        lines: d.lines.map((l) => ({
          itemCode: l.itemCode,
          description: l.description,
          quantity: l.quantity,
          unitAmount: l.unitAmount,
        })),
      });
      created += 1;
      total += res.total ?? d.total;
      days.push({
        date: d.date, day: DAY_LABEL(d), kind: "created",
        reference: d.reference,
        invoiceNumber: res.invoiceNumber,
        total: res.total ?? d.total,
        url: res.url,
        lines: d.lines.length,
      });
    } catch (e) {
      // One day failing does not undo the days that landed, and it must
      // not hide them either. Report per day and let the person see
      // exactly which invoices exist. Re-running is safe: the key is per
      // store per day.
      const msg =
        e instanceof XeroError ? e.message
        : e instanceof Error ? e.message
        : "The invoice could not be created.";
      days.push({ date: d.date, day: DAY_LABEL(d), kind: "failed", error: msg });
    }
  }

  return {
    ok: true,
    weekStart: input.weekStart,
    days,
    created,
    total: Math.round(total * 100) / 100,
  };
}
