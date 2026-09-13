/**
 * harris-farm-check.ts — everything about the Harris Farm pull that can be
 * proved without their credential.
 *
 * The one thing it cannot check is the live API, because the username and
 * password live in Jesse's Key Vault. So it checks the part that would
 * otherwise be assumed: that whatever shape the API answers in, the rows come
 * out of our own parser the same as the portal export does.
 *
 * Run:  npx tsx scripts/harris-farm-check.ts <partnerhub.csv>
 */
import { readFileSync } from "node:fs";
import { parseColesWorkbook } from "../lib/feeds/coles";
import { renameApiFields, rowsToCsv, weekEndingsToPull } from "../lib/feeds/harrisfarm";

const [portalCsv] = process.argv.slice(2);

function splitLine(line: string): string[] {
  const out: string[] = [];
  let f = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(f); f = ""; }
    else f += c;
  }
  out.push(f);
  return out;
}

/** The portal CSV, read back as the list of objects an API would hand us. */
function csvToRows(text: string): Record<string, unknown>[] {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const head = splitLine(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = splitLine(l);
    const o: Record<string, unknown> = {};
    head.forEach((h, i) => { o[h] = cells[i] ?? ""; });
    return o;
  });
}

(async () => {
  console.log("weeks it would pull today:", weekEndingsToPull());
  console.log("  (Sundays, newest first — the previous week is re-read every run");
  console.log("   so a late correction to a Friday is not invisible)\n");

  const sundays = weekEndingsToPull(new Date("2026-09-09T00:00:00Z"), 3);
  const ok = sundays.join(",") === "20260913,20260906,20260830";
  console.log(ok ? "PASS — week maths" : `FAIL — week maths gave ${sundays.join(",")}`);

  // -------------------------------------------------------------------------
  // THE REAL RESPONSE, WHICH NOBODY HAD SEEN UNTIL 14 SEPTEMBER.
  //
  // This runs with no argument, so CI covers it. It has to: the tall check
  // further down was written before anyone had seen the API answer, so it
  // invented friendly headers -- Date, Sales Qty, Invoice Cost -- and passed
  // for a fortnight while the actual response used timeID, quantity and
  // salesIncTax, two of which are required columns the matcher does not know.
  // A test that makes up the input is a test that agrees with itself.
  //
  // These nine fields and these values are copied from a live response.
  // -------------------------------------------------------------------------
  const apiRows: Record<string, unknown>[] = [
    { vendorCode: 6086, timeID: 20260824, weekEndingDate: 20260830, storeNumber: 40, storeName: "HFM Erina",
      itemNo: 20781, itemDescription: "JESSES WHITE SOURDOUGH 900G", quantity: 3, salesIncTax: 23.07 },
    { vendorCode: 6086, timeID: 20260824, weekEndingDate: 20260830, storeNumber: 40, storeName: "HFM Erina",
      itemNo: 20782, itemDescription: "JESSES W/M S'DOUGH BREAD 900G", quantity: 1, salesIncTax: 7.69 },
    { vendorCode: 6086, timeID: 20260825, weekEndingDate: 20260830, storeNumber: 57, storeName: "HFM Bondi Beach",
      itemNo: 80515, itemDescription: "JESSE'S MINI CHALLAH 4P 400G", quantity: 2, salesIncTax: 12.98 },
  ];

  let apiFailures = 0;
  const apiFail = (why: string) => { apiFailures++; console.log("FAIL — " + why); };

  // Untouched, this is what the pull used to hand the loader. It does not come
  // back with zero rows -- it THROWS, naming the columns it could not find,
  // which is what the morning of a new credential would actually have looked
  // like. Asserted so that if anyone widens the shared matcher later, this
  // fails loudly rather than the rename quietly becoming untested.
  let rawRefused = "";
  try {
    const rawParse = await parseColesWorkbook(Buffer.from(rowsToCsv(apiRows), "utf8"));
    if (rawParse.rows.length === 0) rawRefused = "no rows";
  } catch (e) {
    rawRefused = e instanceof Error ? e.message : String(e);
  }
  if (!rawRefused) {
    apiFail("the API's own field names load without the rename, so the rename is now untested");
  } else if (!/salesqty|day/i.test(rawRefused) && rawRefused !== "no rows") {
    apiFail(`the unrenamed rows were refused, but not for the missing columns: ${rawRefused}`);
  } else {
    console.log("  unrenamed, the loader refuses it:", rawRefused.split("\n")[0].slice(0, 120));
  }

  const named = renameApiFields(apiRows);
  if (Object.keys(named[0]).some((k) => k === "timeID" || k === "quantity" || k === "salesIncTax")) {
    apiFail("renameApiFields left one of the three unmapped names in place");
  }
  if (named[0].storeNumber !== 40 || named[0].itemNo !== 20781) {
    apiFail("renameApiFields changed a field the matcher already understood");
  }

  const apiParse = await parseColesWorkbook(Buffer.from(rowsToCsv(named), "utf8"));
  if (apiParse.rejects.length !== 0) {
    apiFail(`the renamed API rows were rejected: ${apiParse.rejects.map((r) => r.reason).join("; ")}`);
  }
  if (apiParse.rows.length !== 3) {
    apiFail(`expected 3 rows from the API shape, got ${apiParse.rows.length}`);
  } else {
    const first = apiParse.rows.find((r) => r.sellItem === "20781");
    if (!first) apiFail("item 20781 did not come through");
    else {
      if (first.saleDate !== "2026-08-24") apiFail(`timeID 20260824 became ${first.saleDate}, not 2026-08-24`);
      if (first.location !== "40") apiFail(`storeNumber 40 became ${first.location}`);
      if (first.salesQty !== 3) apiFail(`quantity 3 became ${first.salesQty}`);
      if (first.invoiceCost !== 23.07) apiFail(`salesIncTax 23.07 became ${String(first.invoiceCost)}`);
    }
  }

  // A WIDE response has none of the three keys and must pass through untouched,
  // or the portal's own export shape breaks on its way through the same code.
  const wideish = [{ StoreNo: 40, "2026-08-24 Qty": 3, "2026-08-24 Sales": 23.07 }];
  if (JSON.stringify(renameApiFields(wideish)) !== JSON.stringify(wideish)) {
    apiFail("renameApiFields altered a wide response, which it must leave alone");
  }

  console.log(apiFailures === 0
    ? "PASS — the API's real field names load, and a wide response is left alone"
    : `FAIL — ${apiFailures} problem(s) with the API field names`);
  console.log();

  if (apiFailures) process.exitCode = 1;

  if (!portalCsv) return;

  // What the manual route produces today.
  const viaPortal = await parseColesWorkbook(readFileSync(portalCsv));

  // What the API route would produce, if the API answers in the portal's own
  // WIDE shape: rows of objects -> our CSV -> the same parser.
  const wide = csvToRows(readFileSync(portalCsv, "utf8"));
  const viaApiWide = await parseColesWorkbook(Buffer.from(rowsToCsv(wide), "utf8"));

  // And if it answers TALL instead, a row per store/item/day. Built from the
  // same numbers so the two are directly comparable.
  const tall: Record<string, unknown>[] = [];
  for (const r of wide) {
    for (const k of Object.keys(r)) {
      const m = /^(\d{4}-\d{2}-\d{2}) Qty$/.exec(k);
      if (!m) continue;
      const qty = String(r[k] ?? "").trim();
      if (qty === "") continue;
      tall.push({
        StoreNo: r.StoreNo, "Store Name": r["Store Name"],
        ItemNo: r.ItemNo, "Item Description": r["Item Description"],
        Date: m[1], "Sales Qty": qty, "Invoice Cost": String(r[`${m[1]} Sales`] ?? "").replace("$", ""),
      });
    }
  }
  const viaApiTall = await parseColesWorkbook(Buffer.from(rowsToCsv(tall), "utf8"));

  const key = (p: Awaited<ReturnType<typeof parseColesWorkbook>>) =>
    p.rows.map((r) => `${r.saleDate}|${r.location}|${r.sellItem}|${r.salesQty}`).sort().join("\n");

  for (const [label, p] of [
    ["portal export (today's route)", viaPortal],
    ["API, wide response", viaApiWide],
    ["API, tall response", viaApiTall],
  ] as const) {
    const byDay: Record<string, number> = {};
    for (const r of p.rows) byDay[r.saleDate] = (byDay[r.saleDate] ?? 0) + r.salesQty;
    console.log(
      `${label.padEnd(30)} rows=${String(p.rows.length).padStart(4)} ` +
      `held back=${String(p.rejects.length).padStart(3)}  ${JSON.stringify(byDay)}`,
    );
  }

  const a = key(viaPortal), b = key(viaApiWide), c = key(viaApiTall);
  console.log();
  console.log(a === b ? "PASS — a wide API response loads identically to the portal export"
                      : "FAIL — wide API response differs from the portal export");
  console.log(a === c ? "PASS — a tall API response loads identically to the portal export"
                      : "FAIL — tall API response differs from the portal export");
})();
