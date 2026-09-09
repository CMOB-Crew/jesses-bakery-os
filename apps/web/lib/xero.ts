/* ------------------------------------------------------------------ *
 * Xero — the Accounting API, for one organisation.
 *
 * WHY A CUSTOM CONNECTION AND NOT AN OAUTH APP
 *
 * Xero has three app types. A standard OAuth app has a refresh token that
 * expires after 60 days unused and rotates on every refresh, so a human
 * has to re-authorise it periodically or invoicing silently stops. That
 * is the wrong shape for something that runs unattended.
 *
 * A Custom Connection is the client_credentials grant: client id and
 * secret, no user interaction, and Xero's own FAQ says outright "refresh
 * tokens are not required. An access token can be requested using only
 * the client_id and client_secret." Access tokens last 30 minutes and are
 * re-requested silently. One organisation per connection, which is
 * exactly what we want. It is a paid add-on.
 *
 * THE ONE THING NOT PROVEN FROM DOCUMENTATION
 *
 * Everything here rests on LineItem.UnitAmount overriding the price
 * stored on the Xero item -- without that, per-customer pricing is
 * impossible and the invoicing module does not work. Xero's own OpenAPI
 * spec and three of their SDKs describe UnitAmount and ItemCode as
 * separate, independently-settable fields with no "recalculate from item"
 * behaviour, and every bulk-invoicing tool relies on that. But their
 * documentation site is a JavaScript app and the page that would say it
 * in one sentence could not be read.
 *
 * So the FIRST invoice this creates is a DRAFT, and it should be opened
 * in Xero and checked before anyone trusts the second one. See
 * createDraftInvoice below -- nothing here can create an AUTHORISED
 * invoice at all.
 *
 * CREDENTIALS live in Supabase secrets. This repository is public.
 * Nothing here logs or returns the client secret, including in an error.
 * ------------------------------------------------------------------ */

import "server-only";

export type XeroConfig = {
  clientId: string;
  clientSecret: string;
  /** Chart-of-accounts code sales post to. Jesse's, not a guess. */
  accountCode: string;
  /** OUTPUT is GST on Income (10%) for an AU org. EXEMPTOUTPUT is GST Free. */
  taxType: string;
};

export class XeroError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "XeroError";
    this.status = status;
  }
}

/** null when Xero is not switched on for this site. */
export function xeroConfig(): XeroConfig | null {
  const clientId = process.env.XERO_CLIENT_ID ?? "";
  const clientSecret = process.env.XERO_CLIENT_SECRET ?? "";
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    accountCode: process.env.XERO_ACCOUNT_CODE ?? "",
    taxType: process.env.XERO_TAX_TYPE ?? "",
  };
}

/**
 * What is still missing before an invoice can be sent, in plain words.
 *
 * The account code and tax type have NO DEFAULT on purpose. A line's
 * TaxType has to be compatible with its AccountCode's own tax rate or
 * Xero rejects the line -- it does not silently default -- and guessing
 * either would either fail loudly or, worse, post a customer's sales to
 * the wrong account in their books. Nobody has told us Jesse's yet.
 */
export function xeroNotReady(cfg: XeroConfig | null): string | null {
  if (!cfg) {
    return (
      "Xero is not connected. XERO_CLIENT_ID and XERO_CLIENT_SECRET come from a " +
      "Xero Custom Connection and belong in Supabase secrets, never the repo."
    );
  }
  if (!cfg.accountCode) {
    return (
      "XERO_ACCOUNT_CODE is not set. It is the chart-of-accounts code Jesse's sales " +
      "post to, and it cannot be guessed — the wrong one puts a customer's sales in " +
      "the wrong place in their books. It is readable off any existing invoice in " +
      "their Xero."
    );
  }
  if (!cfg.taxType) {
    return (
      "XERO_TAX_TYPE is not set. For an AU organisation OUTPUT is GST on Income (10%) " +
      "and EXEMPTOUTPUT is GST Free Income. It has to match the tax rate on the account " +
      "above or Xero refuses the line."
    );
  }
  return null;
}

/**
 * An access token. Thirty minutes, re-requested silently, no refresh
 * token and no human. Not cached across requests deliberately: this runs
 * a handful of times a week, and a stale token cached in a serverless
 * instance is a harder bug than one extra round trip.
 */
export async function xeroToken(cfg: XeroConfig): Promise<string> {
  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization:
        "Basic " + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64"),
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      scope: "accounting.transactions accounting.contacts.read accounting.settings.read",
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 400) {
      throw new XeroError(
        "Xero refused the connection. The client id or secret is wrong, or the Custom " +
        "Connection subscription has lapsed. Nothing has been sent.",
        res.status,
      );
    }
    throw new XeroError(
      `Xero's token endpoint returned ${res.status}. ${text.slice(0, 200)} Nothing has been sent.`,
      res.status,
    );
  }
  let token: string | undefined;
  try {
    token = (JSON.parse(text) as { access_token?: string }).access_token;
  } catch {
    /* fall through */
  }
  if (!token) {
    throw new XeroError("Xero returned no access token. Nothing has been sent.", res.status);
  }
  return token;
}

/** The tenant this connection is for. One org per Custom Connection. */
export async function xeroTenantId(token: string): Promise<string> {
  const res = await fetch("https://api.xero.com/connections", {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new XeroError(
      `Xero returned ${res.status} listing connections. ${text.slice(0, 200)}`,
      res.status,
    );
  }
  const list = JSON.parse(text) as { tenantId?: string }[];
  const id = Array.isArray(list) && list[0]?.tenantId;
  if (!id) {
    throw new XeroError(
      "This Xero connection is not attached to an organisation. Nothing has been sent.",
    );
  }
  return id;
}

export type XeroInvoiceResult = {
  invoiceId: string;
  invoiceNumber: string | null;
  total: number | null;
  status: string | null;
  /** Deep link, so a person can open it and check it. */
  url: string;
};

/**
 * Create ONE draft sales invoice.
 *
 * DRAFT, always. There is no parameter to make it anything else, and
 * that is deliberate: a draft is fully editable and can be deleted, an
 * AUTHORISED invoice with a payment against it is effectively locked, and
 * the whole per-customer-price mechanism has not yet been confirmed
 * against a real Xero organisation. Simona approves and sends from inside
 * Xero, which is also how the legacy system behaved.
 *
 * The Idempotency-Key is what makes a retry safe. Timeouts are the case
 * where you cannot tell whether the first call landed, and a duplicate
 * invoice to a real customer is a phone call from Jesse.
 */
export async function createDraftInvoice(
  cfg: XeroConfig,
  token: string,
  tenantId: string,
  input: {
    contactId: string;
    reference: string;
    dueDate?: string;
    idempotencyKey: string;
    lines: { itemCode: string; description: string; quantity: number; unitAmount: number }[];
  },
): Promise<XeroInvoiceResult> {
  const body = {
    Invoices: [
      {
        Type: "ACCREC",
        Status: "DRAFT",
        Contact: { ContactID: input.contactId },
        Reference: input.reference,
        ...(input.dueDate ? { DueDate: input.dueDate } : {}),
        LineItems: input.lines.map((l) => ({
          ItemCode: l.itemCode,
          Description: l.description,
          Quantity: l.quantity,
          UnitAmount: l.unitAmount,
          AccountCode: cfg.accountCode,
          TaxType: cfg.taxType,
        })),
      },
    ],
  };

  const res = await fetch("https://api.xero.com/api.xro/2.0/Invoices", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "xero-tenant-id": tenantId,
      "content-type": "application/json",
      accept: "application/json",
      "Idempotency-Key": input.idempotencyKey.slice(0, 128),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new XeroError(
      `Xero refused the invoice (${res.status}). ${text.slice(0, 400)}`,
      res.status,
    );
  }

  const parsed = JSON.parse(text) as {
    Invoices?: { InvoiceID?: string; InvoiceNumber?: string; Total?: number; Status?: string }[];
  };
  const inv = parsed.Invoices?.[0];
  if (!inv?.InvoiceID) {
    throw new XeroError("Xero accepted the call but returned no invoice.", res.status);
  }
  return {
    invoiceId: inv.InvoiceID,
    invoiceNumber: inv.InvoiceNumber ?? null,
    total: inv.Total ?? null,
    status: inv.Status ?? null,
    url: `https://go.xero.com/AccountsReceivable/Edit.aspx?InvoiceID=${inv.InvoiceID}`,
  };
}
