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
import { rowsToCsv, weekEndingsToPull } from "../lib/feeds/harrisfarm";

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
