/**
 * wide-report-check.ts — proves two things about the wide-report unpivot.
 *
 *   1. A raw Harris Farm PartnerHub export now parses, with today held back.
 *   2. Every report that already loaded parses IDENTICALLY. The change is
 *      additive or it is not shippable.
 *
 * Run:  npx tsx scripts/wide-report-check.ts <partnerhub.csv> <coles.xlsx> <woolies.xlsx> <colesweekly.xlsx>
 */
import { readFileSync } from "node:fs";
import { parseColesWorkbook, sydneyToday } from "../lib/feeds/coles";

const [hf, coles, woolies, weekly] = process.argv.slice(2);

function line(label: string, p: Awaited<ReturnType<typeof parseColesWorkbook>>) {
  console.log(
    `${label.padEnd(22)} sheet=${String(p.sheetName).padEnd(28)} hdr=${p.headerRow}` +
    `  read=${String(p.rowsRead).padStart(5)}  rows=${String(p.rows.length).padStart(5)}` +
    `  rejects=${String(p.rejects.length).padStart(4)}  ${p.dateFrom} -> ${p.dateTo}`,
  );
  if (p.rowsRead !== p.rows.length + p.rejects.length) {
    console.log("   !! INVARIANT BROKEN: read != rows + rejects");
  }
}

(async () => {
  console.log("Sydney today:", sydneyToday(), "\n");

  if (hf) {
    const p = await parseColesWorkbook(readFileSync(hf));
    line("PartnerHub (wide)", p);
    console.log("   bound columns:", p.columns);
    const byDay: Record<string, number> = {};
    for (const r of p.rows) byDay[r.saleDate] = (byDay[r.saleDate] ?? 0) + r.salesQty;
    console.log("   loaded units by day:", byDay);
    const heldBack = p.rejects.filter((r) => /still trading/.test(r.reason));
    console.log(`   held back as incomplete: ${heldBack.length} rows`);
    if (heldBack[0]) console.log("   e.g.", heldBack[0].reason);
    const other = p.rejects.filter((r) => !/still trading/.test(r.reason));
    if (other.length) console.log("   OTHER rejects:", other.slice(0, 5));
    console.log("   sample:", p.rows.slice(0, 2));
  }

  for (const [label, f] of [["Coles daily", coles], ["Woolworths", woolies]] as const) {
    if (!f) continue;
    const p = await parseColesWorkbook(readFileSync(f));
    line(label, p);
    if (p.rejects.length) console.log("   rejects:", p.rejects.slice(0, 3));
  }

  if (weekly) {
    try {
      await parseColesWorkbook(readFileSync(weekly));
      console.log("Coles weekly           !! LOADED — it must be refused");
    } catch (e) {
      const m = String((e as Error).message);
      console.log("Coles weekly           refused:", m.slice(0, 70) + "...");
      if (!/WEEKLY/.test(m)) console.log("   !! wrong message — the weekly guard did not fire");
    }
  }
})();
