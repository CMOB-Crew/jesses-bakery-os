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
 * exactly what we want. It is a paid add-on, and Jesse already has one:
 * the legacy Data Factory authenticates with client_credentials out of
 * Key Vault, which only exists via a Custom Connection. Confirmed by
 * @Fred, 11 September 2026.
 *
 * THE THING THAT WAS NOT PROVEN IS NOW PROVEN
 *
 * Everything here rests on LineItem.UnitAmount overriding the price
 * stored on the Xero item -- without that, per-customer pricing is
 * impossible and the invoicing module does not work. This comment used to
 * say that could not be confirmed: Xero's OpenAPI spec and three of their
 * SDKs describe UnitAmount and ItemCode as separate, independently
 * settable fields, but their documentation site is a JavaScript app and
 * the page that would say it in one sentence could not be read.
 *
 * @Fred settled it on 11 September 2026 against production data rather
 * than against a spec. In the week he pulled out of Jesse's Data Factory,
 * Bagel 5 Pack goes out at 4.50, 4.95, 5.00 and 5.20 to four different
 * customers on the SAME ItemCode, and Challah Large at nine different
 * prices. Per-customer UnitAmount overriding the item price is how every
 * invoice has been sent since May 2025.
 *
 * Everything this creates is still a DRAFT, and there is no parameter to
 * make it anything else. Production posts drafts too -- all 94 in the week
 * he pulled -- and Simona sends them from inside Xero.
 *
 * CREDENTIALS live in Supabase secrets. This repository is public.
 * Nothing here logs or returns the client secret, including in an error.
 * ------------------------------------------------------------------ */

import "server-only";
import { invoiceBody, type XeroInvoiceInput } from "@/lib/xero-invoice";

export type XeroConfig = {
  clientId: string;
  clientSecret: string;
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
  return { clientId, clientSecret };
}

/**
 * What is still missing before an invoice can be sent, in plain words.
 *
 * THIS USED TO DEMAND TWO MORE THINGS, AND IT WAS WRONG TO.
 *
 * It refused to send anything without XERO_ACCOUNT_CODE and XERO_TAX_TYPE,
 * on the reasoning that a line's TaxType has to be compatible with its
 * AccountCode's own tax rate or Xero rejects the line, and that guessing
 * either would post a customer's sales to the wrong place in their books.
 * The second half of that is true. The conclusion was not.
 *
 * @Fred pulled a real invoice file out of Jesse's Data Factory on
 * 11 September. The old system has been invoicing these same customers
 * since May 2025 and it sends NEITHER FIELD. The whole payload is:
 *
 *   Type, Contact.ContactID, Date, DueDate, Reference, Status
 *   LineItems[]: Description, Quantity, UnitAmount, ItemCode, LineAmount
 *
 * Xero fills the account and the tax from the ITEM. Which means sending
 * them was not the safe option, it was the dangerous one: our value would
 * have overridden whatever the item says, and put the same customers on a
 * different account and a different tax rate than every invoice they have
 * had for sixteen months. The guard was blocking the build to protect
 * against a risk it was itself creating.
 *
 * It also makes the ItemCode lookup load-bearing, which is where the real
 * risk now sits -- ProductXeroItems is 590 items pulled out of Xero's API
 * Explorer by hand in September 2024 and never refreshed. With no
 * AccountCode in the payload, a stale ItemCode is a FAILED LINE, not a
 * cosmetic problem.
 */
export function xeroNotReady(cfg: XeroConfig | null): string | null {
  if (!cfg) {
    return (
      "Xero is not connected. XERO_CLIENT_ID and XERO_CLIENT_SECRET come from a " +
      "Xero Custom Connection and belong in Supabase secrets, never the repo."
    );
  }
  return null;
}

/**
 * THE SCOPES, AND WHY THIS IS CONFIGURATION AND NOT A CONSTANT.
 *
 * This value has now been wrong twice, in opposite directions, and both
 * times the code still looked correct. That is the argument for the shape
 * below, so the history is worth keeping.
 *
 * It originally asked for three:
 *
 *     accounting.transactions accounting.contacts.read accounting.settings.read
 *
 * On 15 September that was MEASURED against our own connection and the
 * first one failed:
 *
 *     scope=accounting.transactions   ->   400 invalid_scope
 *     scope=accounting.invoices       ->   200
 *
 * so it was changed to accounting.invoices (8024919). That measurement was
 * real. It was taken against the WRONG CONNECTION.
 *
 * @Fred measured Jesse's production connection the same morning and got
 * the exact inverse:
 *
 *     accounting.transactions      200
 *     accounting.contacts.read     200
 *     accounting.invoices          400 invalid_scope
 *     accounting.settings.read     400 invalid_scope
 *
 * His words: "your accounting.invoices change is right for the demo and
 * wrong for prod - against Jesse's connection it fails at the token
 * endpoint, and step 4 would have died before reaching Xero. Scope per
 * environment, not one value."
 *
 * BOTH MEASUREMENTS ARE CORRECT, and the reason is the cutover date. Our
 * app was created on 14 September 2026, so it only has granular scopes.
 * Jesse's predates 2 March 2026, so Xero leaves it on the legacy ones
 * until September 2027. Two connections to the same API with disjoint
 * vocabularies.
 *
 * @Fred's rule, from both probes, and it is the useful part:
 *
 *     You can request any SUBSET of what the connection was configured
 *     with, but never a scope it does not hold -- INCLUDING A NARROWER
 *     SIBLING. Demo holds contacts and refused contacts.read; prod holds
 *     contacts.read and accepted it.
 *
 * A scope the connection does not hold fails the WHOLE token request, so
 * this one line decides whether anything can be invoiced at all. It is the
 * highest-consequence string in the repository and it cannot be verified
 * from inside the repository, because the answer lives on whichever
 * connection the credentials happen to point at.
 *
 * SO IT IS AN ENVIRONMENT VARIABLE. Not because that is tidier, but
 * because when it is wrong the fix must not require a deploy -- and it has
 * been wrong on every single day it has been looked at.
 *
 * WHICH FILE TALKS TO WHICH CONNECTION
 *
 *   lib/xero.ts (this file)        the app's Draft button. PRODUCTION.
 *                                  Reached only by app/store/xero-actions.ts.
 *   scripts/xero-demo-draft.ts     the demo org. Carries its OWN list and
 *                                  always had it right, which is exactly
 *                                  why nobody noticed this file was broken.
 *
 * That is why the default below is the PRODUCTION string. If this variable
 * is unset in Netlify, the app must still be able to bill Jesse.
 *
 * WHY accounting.contacts.read IS NOT IN THE DEFAULT, even though prod
 * grants it and @Fred measured it at 200: nothing in this file reads a
 * contact. Two Xero endpoints are touched here and no others --
 * /connections, to learn which organisation the connection is for, and
 * /api.xro/2.0/Invoices, to create a draft. An invoice names an existing
 * customer by ContactID; it does not read them. The rule this file already
 * carried still stands, and it is the right one:
 *
 *     ADD THE SCOPE AT THE SAME TIME AS THE CODE THAT USES IT, and have
 *     @Fred grant it on the production connection FIRST. A scope the
 *     connection does not hold does not disable the new feature. It takes
 *     down invoicing entirely.
 *
 * When ContactID validation gets built -- and it should, it recovers half
 * of what the settings.read refusal costs us before step 4 -- it arrives
 * with accounting.contacts.read, not before.
 *
 * WHAT THE NARROWNESS BUYS. Measured 15 September on a token holding
 * accounting.invoices and nothing else:
 *
 *     GET /Items     401     GET /Contacts         401
 *     GET /Accounts  401     GET /BankTransactions 401
 *
 * The equivalent has NOT been measured on the legacy scope, and
 * accounting.transactions is broader than accounting.invoices by
 * construction. So a stolen production secret is not as tightly boxed in
 * as it is on the demo connection. That is a real and accepted cost of
 * Jesse's connection being old, not something this file can fix.
 *
 * AND THE ONE THAT STILL HURTS. accounting.settings.read is refused on
 * prod -- @Fred confirmed it, measured, on 15 September. Reading Items
 * needs it. So THE 30 ITEM CODES CANNOT BE CHECKED AGAINST JESSE'S
 * ORGANISATION FROM HERE before the first real invoice. A wrong code is a
 * loud rejection on that line rather than a silent mispricing, which is
 * the safe direction, but step 4 is where it shows up. @Fred's read-only
 * web app plus one consent click from Simona is the way round it, and that
 * is a separate app registration -- this one is a Custom Connection using
 * client_credentials, so it has no redirect URI at all.
 */

/**
 * Jesse's production connection. Legacy scopes, because his Xero app
 * predates the 2 March 2026 granular cutover.
 *
 * The demo organisation needs "accounting.invoices" instead. Set
 * XERO_SCOPES to override without a deploy.
 */
export const DEFAULT_XERO_SCOPES = "accounting.transactions";

/**
 * Read at module load, so a bad value shows up once rather than per call.
 * Trimmed, because a trailing space in a Netlify environment variable is
 * invisible in the dashboard and fails the token request identically to a
 * wrong scope.
 */
export const XERO_SCOPES: string =
  (process.env.XERO_SCOPES ?? "").trim() || DEFAULT_XERO_SCOPES;

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
      scope: XERO_SCOPES,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 400) {
      throw new XeroError(
        // Name the scope string AND the variable that changes it. This message
        // is the only thing anybody has to go on when it fires, and the answer
        // is different on Jesse's connection than on the demo org -- so
        // "check the scopes" without saying which ones is not an instruction.
        `Xero refused the connection, asking for scope "${XERO_SCOPES}". ` +
        "Nothing has been sent.\n\n" +
        "A scope the connection does not hold fails the WHOLE token request, so " +
        "check that before the credentials. It is also per-connection: Jesse's " +
        "production app predates the 2 March 2026 granular cutover and holds " +
        "accounting.transactions; an app created since holds accounting.invoices " +
        "and refuses the other. Measured both ways on 15 September.\n\n" +
        "Set the XERO_SCOPES environment variable to change this without a " +
        `deploy. It is currently ${process.env.XERO_SCOPES ? "set explicitly" : "unset, so the production default is in use"}.\n\n` +
        "Otherwise the client id or secret is wrong, or the Custom Connection " +
        "has lapsed.",
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
 * that is deliberate: a draft is fully editable and can be deleted, while
 * an AUTHORISED invoice with a payment against it is effectively locked.
 * It is also what production does -- every one of the 94 invoices in the
 * week @Fred pulled was posted as DRAFT. Simona approves and sends from
 * inside Xero, which is how the legacy system has always behaved.
 *
 * ONE INVOICE PER STORE PER DELIVERY DAY, dated on that day. The caller
 * supplies Date and DueDate; this used to send neither, which left Xero
 * dating every invoice the day it happened to be drafted.
 *
 * The Idempotency-Key is what makes a retry safe. Timeouts are the case
 * where you cannot tell whether the first call landed, and a duplicate
 * invoice to a real customer is a phone call from Jesse.
 */
export async function createDraftInvoice(
  token: string,
  tenantId: string,
  input: XeroInvoiceInput,
): Promise<XeroInvoiceResult> {
  const body = invoiceBody(input);

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
