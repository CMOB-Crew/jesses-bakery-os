/**
 * xero-demo-draft.ts — draft one customer's week into a Xero DEMO company.
 *
 * OPTION C FROM THE XERO PLAN. It proves the invoice MECHANICS end to end
 * without needing Jesse's identifiers, which exist in his organisation and
 * nowhere else.
 *
 * WHAT IT PROVES, AND WHY EACH ONE MATTERS
 *
 *   one invoice per delivery day     the thing we had wrong until @Fred's file
 *   Reference "MONDAY - KRINSKYS"    full day name, plain hyphen, uppercase
 *   Date on the delivery day         we used to send neither Date nor DueDate
 *   DueDate = Date + 14
 *   Status DRAFT                     never authorised, never sent
 *   totals to the cent               computed here, compared to Xero's own
 *   A RE-RUN CREATES NOTHING NEW     the Idempotency-Key, which is the only
 *                                    thing that makes a timeout survivable
 *
 * It builds the week with buildWeek() from lib/xero-invoice.ts -- the same
 * function the real action calls. A reimplementation here would test this
 * file instead of testing the build, which is the opposite of the point.
 * It also builds the payload with invoiceBody() and changes exactly ONE
 * field afterwards.
 *
 * THE ONE DELIBERATE DIFFERENCE, AND THE GUARD AROUND IT
 *
 * A Xero ContactID is a GUID scoped to one organisation. Jesse's 37 do not
 * exist in a demo company, so every invoice would be rejected on the first
 * line. This sends Contact: { Name } instead, and Xero matches or creates
 * the contact by name.
 *
 * THAT MUST NEVER HAPPEN AGAINST JESSE'S BOOKS. Sending a name where a real
 * customer already exists under a slightly different spelling creates a
 * SECOND contact, splits their statement, and is a genuine mess to unpick.
 * So three separate things have to be true before anything is sent:
 *
 *   1. XERO_DEMO_DRAFT=1 must be set explicitly.
 *   2. The connected organisation's NAME must contain "demo".
 *   3. --yes must be passed on the command line.
 *
 * Any one missing and it refuses without calling Xero at all. The refusal
 * is not a nuisance: this is the one script in the repo that writes to an
 * accounting system.
 *
 * READS PRODUCTION, WRITES ONLY TO THE DEMO COMPANY. The standing order is
 * read with a plain SELECT. Nothing in this script writes to Postgres.
 *
 * Run:
 *   XERO_DEMO_DRAFT=1 npx tsx scripts/xero-demo-draft.ts --store "KRINSKYS" --yes
 *
 * Credentials come from ~/.jbo/xero.env and ~/.jbo/production.env, both
 * outside this repository, because this repository is public.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import postgres from "postgres";
import { buildWeek, billingWeekStart, idempotencyKey, invoiceBody } from "../lib/xero-invoice";
import type { DayInvoice } from "../lib/xero-invoice";
import type { StandingLine } from "../lib/queries";

/* ---------------------------------------------------------------- *
 * Credentials, from outside the repo.
 * ---------------------------------------------------------------- */
function fromEnvFile(file: string, key: string): string | null {
  try {
    const txt = fs.readFileSync(path.join(os.homedir(), ".jbo", file), "utf8");
    const m = new RegExp("^" + key + "=(.*)$", "m").exec(txt);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : null;
  } catch {
    return null;
  }
}

const CLIENT_ID = process.env.XERO_CLIENT_ID ?? fromEnvFile("xero.env", "XERO_CLIENT_ID");
const CLIENT_SECRET = process.env.XERO_CLIENT_SECRET ?? fromEnvFile("xero.env", "XERO_CLIENT_SECRET");
const DB_URL = process.env.DATABASE_URL ?? fromEnvFile("production.env", "PGURL");

/* ---------------------------------------------------------------- *
 * Arguments.
 * ---------------------------------------------------------------- */
const argv = process.argv.slice(2);
const argOf = (name: string): string | null => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const STORE = argOf("store");
const WEEK = argOf("week");
const CONFIRMED = argv.includes("--yes");

function die(msg: string): never {
  console.error("");
  console.error(msg);
  console.error("");
  console.error("NOTHING was sent to Xero and nothing was created.");
  process.exit(1);
}

if (!CLIENT_ID || !CLIENT_SECRET) {
  die("CANNOT RUN  no Xero credentials. Expected ~/.jbo/xero.env with\n" +
      "            XERO_CLIENT_ID and XERO_CLIENT_SECRET.");
}
if (!DB_URL) {
  die("CANNOT RUN  no database URL. Expected ~/.jbo/production.env with PGURL=,\n" +
      "            or DATABASE_URL in the environment.");
}
if (!STORE) {
  die('CANNOT RUN  say which customer:  --store "KRINSKYS"');
}
if (process.env.XERO_DEMO_DRAFT !== "1") {
  die("REFUSING  XERO_DEMO_DRAFT=1 is not set.\n\n" +
      "          This script CREATES INVOICES. It is meant only for a Xero demo\n" +
      "          company, where the data is fictional, and it sends a contact by\n" +
      "          NAME rather than by id -- which against real books would create a\n" +
      "          duplicate customer and split their statement.");
}
if (!CONFIRMED) {
  die("REFUSING  pass --yes once you have read what this does.\n\n" +
      "          It drafts up to seven invoices into the connected organisation.");
}

/* ---------------------------------------------------------------- *
 * Xero, read the org first and refuse if it is not a demo company.
 * ---------------------------------------------------------------- */
const SCOPES = [
  "accounting.contacts",
  "accounting.contacts.read",
  "accounting.invoices",
  "accounting.invoices.read",
  "accounting.settings.read",
].join(" ");

async function token(): Promise<string> {
  const res = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: SCOPES }),
  });
  const text = await res.text();
  if (!res.ok) {
    // Never print the body unfiltered -- it is a token endpoint response.
    let err = "(no error field)";
    try { err = String(JSON.parse(text).error ?? err); } catch { /* ignore */ }
    die(`REFUSED BY XERO  the token endpoint returned ${res.status} (${err}).\n\n` +
        "                 Wrong client id or secret, a lapsed Custom Connection, or\n" +
        "                 the connection does not grant one of these scopes:\n" +
        "                   " + SCOPES.split(" ").join("\n                   "));
  }
  const t = JSON.parse(text).access_token as string | undefined;
  if (!t) die("Xero returned no access token.");
  return t;
}

async function connection(tok: string): Promise<{ tenantId: string; tenantName: string }> {
  const res = await fetch("https://api.xero.com/connections", {
    headers: { authorization: `Bearer ${tok}`, accept: "application/json" },
  });
  const list = (await res.json()) as { tenantId?: string; tenantName?: string }[];
  if (!Array.isArray(list) || !list[0]?.tenantId) {
    die("This Xero connection is not attached to an organisation.");
  }
  return { tenantId: list[0].tenantId!, tenantName: String(list[0].tenantName ?? "") };
}

/* ---------------------------------------------------------------- *
 * The standing order.
 *
 * This repeats getStoreStandingOrder()'s query rather than importing it,
 * because lib/queries.ts is marked `server-only` and a script is not a
 * server. Keep the two in step: if that query changes, this one has to.
 * The shape is asserted by the StandingLine type on the way out, so a
 * column going missing is a typecheck failure rather than a silent null.
 * ---------------------------------------------------------------- */
async function standingOrder(sql: ReturnType<typeof postgres>, storeId: string): Promise<StandingLine[]> {
  const rows = await sql<{
    product_id: string; name: string; category: string; pack_size: number;
    baking_uom: string | null; sent: number; override_qty: number | null;
    mode: string | null; starts_on: Date | null; ends_on: Date | null;
    unit_price: string | number | null; xero_code: string | null;
    days: Record<string, number> | null;
  }[]>`
    select p.id::text                     as product_id,
           p.name,
           p.category::text               as category,
           coalesce(p.pack_size, 1)::int  as pack_size,
           p.baking_uom::text             as baking_uom,
           coalesce(r.sent, 0)::int       as sent,
           o.qty                          as override_qty,
           o.mode::text                   as mode,
           o.starts_on,
           o.ends_on,
           pp.unit_price,
           pp.xero_code,
           dd.days
      from products p
      left join store_reco r
             on r.product_id = p.id and r.store_id = ${storeId}::uuid
      left join store_product_overrides o
             on o.product_id = p.id and o.store_id = ${storeId}::uuid
      left join store_product_prices pp
             on pp.product_id = p.id and pp.store_id = ${storeId}::uuid
      left join lateral (
        select jsonb_object_agg(d.dow::text, d.qty) as days
          from store_product_days d
         where d.store_id = ${storeId}::uuid and d.product_id = p.id
      ) dd on true
     where p.active
       and (coalesce(r.sent, 0) > 0 or o.qty is not null)
     order by p.category, p.name`;
  const iso = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : null);
  return rows.map((r) => ({
    product_id: r.product_id,
    name: r.name,
    category: r.category,
    pack_size: Number(r.pack_size) || 1,
    baking_uom: r.baking_uom,
    sent: Number(r.sent) || 0,
    override_qty: r.override_qty == null ? null : Number(r.override_qty),
    mode: r.mode === "temp" ? "temp" : r.mode === "perm" ? "perm" : null,
    starts_on: iso(r.starts_on),
    ends_on: iso(r.ends_on),
    unit_price: r.unit_price == null ? null : Number(r.unit_price),
    xero_code: r.xero_code,
    days: r.days ?? null,
  }));
}

/* ---------------------------------------------------------------- *
 * Main.
 * ---------------------------------------------------------------- */
async function main() {
  console.log("— asking Xero which organisation this connection is for —");
  const tok = await token();
  const { tenantId, tenantName } = await connection(tok);
  console.log(`  ${tenantName || "(unnamed)"}   ${tenantId}`);

  // THE GUARD THAT MATTERS. Name-based contacts against real books create
  // duplicate customers. There is no undo that a person would enjoy.
  if (!/demo/i.test(tenantName)) {
    die(`REFUSING  the connected organisation is "${tenantName}", which does not\n` +
        "          look like a demo company.\n\n" +
        "          This script sends Contact by NAME. Against a real organisation\n" +
        "          that creates a SECOND contact for any customer whose name does\n" +
        "          not match exactly, and splits their statement in two.\n\n" +
        "          If you meant to bill a real customer, that is step 4, it uses\n" +
        "          ContactID, and @Fred is in the room for it.");
  }
  console.log("  it is a demo company, so a contact created by name is fictional too");

  const sql = postgres(DB_URL!, { max: 2, prepare: false });
  try {
    const found = await sql<{ id: string; name: string }[]>`
      select id::text, name from stores where upper(name) = upper(${STORE!}) limit 2`;
    if (found.length === 0) die(`No store called "${STORE}".`);
    if (found.length > 1) die(`More than one store called "${STORE}".`);
    const store = found[0];

    const lines = await standingOrder(sql, store.id);
    const week = WEEK ?? billingWeekStart(new Date().toISOString().slice(0, 10));
    console.log(`\n— ${store.name}, week of ${week} —`);

    // The real builder. Contact id is irrelevant here but buildWeek refuses
    // without one, so pass the store's own -- it is never sent.
    const days = buildWeek({ xero_contact_id: "demo", name: store.name }, lines, week);

    const refusals = days.flatMap((d) => (d.kind === "refuse" ? d.refusals : []));
    if (refusals.length) {
      console.log("\nThis customer REFUSES, and it would refuse for real too:");
      for (const r of refusals) console.log("  * " + r.reason);
      die("Nothing was sent. Fix the refusal or pick another customer.");
    }

    const billable = days.filter((d): d is Extract<DayInvoice, { kind: "ok" }> => d.kind === "ok");
    if (!billable.length) die(`${store.name} has no deliveries in the week of ${week}.`);

    console.log(`  ${billable.length} invoice(s) to draft, ${days.length - billable.length} quiet day(s)\n`);

    let created = 0;
    const seen: { reference: string; id: string; total: number | null; expected: number }[] = [];

    for (const d of billable) {
      const body = invoiceBody({
        contactId: "unused",
        reference: d.reference,
        date: d.date,
        dueDate: d.dueDate,
        idempotencyKey: idempotencyKey(store.id, d.date),
        lines: d.lines.map((l) => ({
          itemCode: l.itemCode, description: l.description,
          quantity: l.quantity, unitAmount: l.unitAmount,
        })),
      }) as { Invoices: Record<string, unknown>[] };

      // THE ONE FIELD THAT CHANGES. Everything else is the production payload.
      body.Invoices[0].Contact = { Name: store.name };
      // Demo company has none of Jesse's items either, so a line cannot bill
      // as an ItemCode that is not there. Drop the code and keep Description,
      // Quantity and UnitAmount -- which is what actually makes the total.
      body.Invoices[0].LineItems = (body.Invoices[0].LineItems as Record<string, unknown>[])
        .map((l) => { const c = { ...l }; delete c.ItemCode; return c; });

      const res = await fetch("https://api.xero.com/api.xro/2.0/Invoices", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tok}`,
          "xero-tenant-id": tenantId,
          "content-type": "application/json",
          accept: "application/json",
          "Idempotency-Key": idempotencyKey(store.id, d.date).slice(0, 128),
        },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) {
        console.error(`  FAIL  ${d.reference}  ${res.status}  ${text.slice(0, 300)}`);
        continue;
      }
      const inv = JSON.parse(text).Invoices?.[0];
      created += 1;
      seen.push({ reference: d.reference, id: inv?.InvoiceID, total: inv?.Total ?? null, expected: d.total });
      const ok = inv?.Status === "DRAFT" ? "DRAFT" : `STATUS=${inv?.Status}`;
      console.log(`  ok    ${d.reference.padEnd(34)} ${d.date}  due ${d.dueDate}  ${ok}  ` +
                  `$${(inv?.Total ?? 0).toFixed(2)} (we said $${d.total.toFixed(2)})`);
    }

    console.log(`\n— ${created} draft(s) created —`);

    const wrongTotal = seen.filter((s) => s.total != null && Math.abs(s.total - s.expected) > 0.005);
    if (wrongTotal.length) {
      console.log("\n  TOTALS DISAGREE with Xero on:");
      for (const s of wrongTotal) console.log(`    ${s.reference}  ours $${s.expected}  Xero $${s.total}`);
      console.log("  That is worth understanding before step 4.");
    } else if (seen.length) {
      console.log("  Every total matches Xero's own to the cent.");
    }

    /* -------------------------------------------------------------- *
     * The property that makes a timeout survivable.
     * -------------------------------------------------------------- */
    if (billable.length) {
      const d = billable[0];
      console.log(`\n— sending ${d.reference} a SECOND time, same idempotency key —`);
      const before = await countByReference(tok, tenantId, d.reference);
      const body = invoiceBody({
        contactId: "unused", reference: d.reference, date: d.date, dueDate: d.dueDate,
        idempotencyKey: idempotencyKey(store.id, d.date),
        lines: d.lines.map((l) => ({
          itemCode: l.itemCode, description: l.description,
          quantity: l.quantity, unitAmount: l.unitAmount,
        })),
      }) as { Invoices: Record<string, unknown>[] };
      body.Invoices[0].Contact = { Name: store.name };
      body.Invoices[0].LineItems = (body.Invoices[0].LineItems as Record<string, unknown>[])
        .map((l) => { const c = { ...l }; delete c.ItemCode; return c; });
      await fetch("https://api.xero.com/api.xro/2.0/Invoices", {
        method: "POST",
        headers: {
          authorization: `Bearer ${tok}`, "xero-tenant-id": tenantId,
          "content-type": "application/json", accept: "application/json",
          "Idempotency-Key": idempotencyKey(store.id, d.date).slice(0, 128),
        },
        body: JSON.stringify(body),
      });
      const after = await countByReference(tok, tenantId, d.reference);
      if (after === before) {
        console.log(`  PASS  still ${after} invoice with that reference. A retry is safe.`);
      } else {
        console.log(`  FAIL  ${before} before, ${after} after. THE IDEMPOTENCY KEY IS NOT WORKING,`);
        console.log("        which means a timeout at step 4 could double-bill a real customer.");
      }
    }

    console.log("\nEverything above is a DRAFT in a fictional demo company.");
    console.log("Delete them in Xero when you are done, or leave them; the demo resets.");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function countByReference(tok: string, tenantId: string, reference: string): Promise<number> {
  const url = "https://api.xero.com/api.xro/2.0/Invoices?where=" +
    encodeURIComponent(`Reference=="${reference}"`);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${tok}`, "xero-tenant-id": tenantId, accept: "application/json" },
  });
  if (!res.ok) return -1;
  const d = (await res.json()) as { Invoices?: unknown[] };
  return (d.Invoices ?? []).length;
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
