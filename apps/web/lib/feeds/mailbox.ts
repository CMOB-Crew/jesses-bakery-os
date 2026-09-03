import "server-only";
import type { MailMessage, MailAttachment } from "./graph";

// ---------------------------------------------------------------------------
// Which email is which retailer's report.
//
// Measured on 2 September from the original headers inside Simona's forwards,
// not from anyone's description of the process:
//
//   Woolworths  wwbakery@woolworths.com.au      -> accounts@ AND systemadmin@
//               "Jesses Bakery - Daily Sales & Units Report"      ~7:23am
//   Coles       no-reply-powerbi@microsoft.com  -> accounts@ ONLY
//               "Daily Pay On Scan - JESSE'S BAKERY"              ~8:22am
//   Harris Farm  no daily email exists at all -- portal only.
//
// MATCH ON SENDER AND SUBJECT, NOT FILENAME. The Coles attachment was already
// renamed once in the Power BI migration -- "Daily Coles - Pay On Scan.xlsx"
// became "Pay on Scan - Daily Report.xlsx" -- and a filename rule would have
// broken silently on the day that happened. The filename is only used to pick
// between attachments once the right message is found.
// ---------------------------------------------------------------------------

export type FeedRule = {
  retailer: "coles" | "woolworths";
  /** Exact sender address, lowercased. */
  sender: string;
  /** Case-insensitive fragment that must appear in the subject. Kept loose
   *  enough to survive a "FW:" prefix or a trailing date, tight enough that no
   *  other mail from the same sender matches. */
  subject: RegExp;
  label: string;
};

export const FEED_RULES: FeedRule[] = [
  {
    retailer: "woolworths",
    sender: "wwbakery@woolworths.com.au",
    subject: /daily sales\s*&?\s*units report/i,
    label: "Woolworths daily sales & units",
  },
  {
    // Power BI sends on Coles' behalf, so the sender is Microsoft, not Coles.
    // The subject is the only thing that says which report it is -- this
    // mailbox could receive other Power BI subscriptions.
    retailer: "coles",
    sender: "no-reply-powerbi@microsoft.com",
    subject: /pay on scan/i,
    label: "Coles daily Pay On Scan",
  },
];

export function ruleFor(msg: MailMessage): FeedRule | null {
  const from = msg.from.toLowerCase();
  for (const r of FEED_RULES) {
    if (from === r.sender && r.subject.test(msg.subject)) return r;
  }
  return null;
}

const SPREADSHEET = /\.(xlsx|xlsm|csv)$/i;

/** The attachment that is actually the report.
 *
 *  A signature image or a logo arrives as an attachment too, so "the first one"
 *  is not good enough. Take the largest spreadsheet: the report is always
 *  vastly bigger than any decoration, and picking by size survives a rename
 *  where picking by name does not. */
export function pickReport(attachments: MailAttachment[]): MailAttachment | null {
  const sheets = attachments.filter((a) => SPREADSHEET.test(a.name));
  if (sheets.length === 0) return null;
  return sheets.reduce((best, a) => (a.size > best.size ? a : best), sheets[0]);
}
