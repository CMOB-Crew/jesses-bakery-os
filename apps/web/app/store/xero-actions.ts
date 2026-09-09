"use server";

import { withUser } from "@/lib/db";
import { getStoreStandingOrder } from "@/lib/queries";
import { buildInvoice, idempotencyKey } from "@/lib/xero-invoice";
import {
  xeroConfig, xeroNotReady, xeroToken, xeroTenantId, createDraftInvoice, XeroError,
} from "@/lib/xero";

/* ------------------------------------------------------------------ *
 * Draft one invoice for one customer, for one week.
 *
 * A DRAFT. Never authorised, never sent. Simona opens it in Xero,
 * checks it and sends it -- which is what the legacy system did when she
 * edited a standing order, and it is also the only honest thing to do
 * until a real Xero organisation has confirmed that a per-customer
 * UnitAmount actually overrides the price on the Xero item. Their
 * documentation site would not yield that sentence and the schema is not
 * the same as a receipt.
 *
 * Everything that decides WHAT is billed lives in lib/xero-invoice.ts and
 * is asserted in scripts/xero-invoice-check.ts. This file only fetches,
 * calls and reports.
 * ------------------------------------------------------------------ */

export type DraftInvoiceResult =
  | { ok: true; invoiceNumber: string | null; total: number | null; url: string; lines: number }
  | { ok: false; error: string; refusals?: { reason: string; lines: string[] }[] };

export async function draftXeroInvoice(input: {
  storeId: string;
  storeName: string;
  xeroContactId: string | null;
  /** Monday of the week being billed, YYYY-MM-DD. Used for the reference
   *  and, more importantly, for the idempotency key. */
  periodStart: string;
}): Promise<DraftInvoiceResult> {
  const cfg = xeroConfig();
  const notReady = xeroNotReady(cfg);
  if (notReady || !cfg) return { ok: false, error: notReady ?? "Xero is not connected." };

  let lines;
  try {
    lines = await withUser(() => getStoreStandingOrder(input.storeId));
  } catch {
    return { ok: false, error: "Could not read this customer's standing order. Nothing has been sent." };
  }

  const draft = buildInvoice(
    { xero_contact_id: input.xeroContactId, name: input.storeName },
    lines,
  );

  // Refusals stop the whole invoice, never a partial one. buildInvoice
  // still returns the billable lines so the message can say what WOULD
  // have gone -- but ok is false and nothing is sent.
  if (!draft.ok) {
    return {
      ok: false,
      error: `Nothing has been sent to Xero. ${draft.refusals.length === 1 ? "One thing" : `${draft.refusals.length} things`} need fixing first.`,
      refusals: draft.refusals,
    };
  }

  try {
    const token = await xeroToken(cfg);
    const tenantId = await xeroTenantId(token);
    const res = await createDraftInvoice(cfg, token, tenantId, {
      contactId: draft.contactId,
      reference: `${input.storeName} — week of ${input.periodStart}`,
      idempotencyKey: idempotencyKey(input.storeId, input.periodStart),
      lines: draft.lines.map((l) => ({
        itemCode: l.itemCode,
        description: l.description,
        quantity: l.quantity,
        unitAmount: l.unitAmount,
      })),
    });
    return {
      ok: true,
      invoiceNumber: res.invoiceNumber,
      total: res.total,
      url: res.url,
      lines: draft.lines.length,
    };
  } catch (e) {
    // A Xero failure is the interesting one and its message already names
    // the fix -- a lapsed subscription, a wrong secret, a rejected tax
    // type. Pass it through rather than flattening it to "something went
    // wrong", and never include the credential.
    const msg =
      e instanceof XeroError ? e.message
      : e instanceof Error ? e.message
      : "The invoice could not be created.";
    return { ok: false, error: msg };
  }
}
