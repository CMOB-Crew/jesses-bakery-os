/* ------------------------------------------------------------------ *
 * Coles "Pay On Scan" report — parser.
 *
 * WHY THIS EXISTS AT ALL
 *
 * Coles' sales reach Jesse as a spreadsheet a person drops into blob
 * storage by hand. Their pipeline then reads a FIXED CELL RANGE out of it —
 * `Weekly Supplier Report`, A4:K100000. On 3 August Coles reissued the report
 * with the header row moved up two lines and one column removed, and that
 * pipeline has read nothing ever since. It reported Success the whole time,
 * because the error handler that would have said otherwise fails too.
 *
 * 115 stores. 16,849 units a week. 39% of everything Jesse bakes, invisible
 * for three weeks, with a green light on the dashboard.
 *
 * So this parser is deliberately built to survive the change that killed
 * theirs, and to be loud when it can't:
 *
 *   - it finds the sheet by looking for one whose header row it recognises,
 *     not by name (their tab was renamed too);
 *   - it finds the HEADER ROW by scanning, not by assuming row 1 or row 3;
 *   - it maps columns BY HEADER NAME, so a dropped or reordered column moves
 *     nothing (in the old layout the `Metrics` column sat between Sell Item
 *     and Sales Qty; the new one drops it, shifting every measure one column
 *     left — a position-based reader silently reads Waste Qty, which is all
 *     zeros, as Sales Qty);
 *   - it never returns a partial success. Rows it cannot understand come back
 *     as rejects with a reason and their row number, for a human to look at.
 *
 * The old and new layouts, from diffing the two files Simona sent on 13 Aug:
 *
 *          OLD                                    NEW
 *   R1  title banner                        R1  column headers
 *   R2  blank                               R2+ data
 *   R3  column headers
 *   R4+ data
 *
 *   Day | State | Location | (store) | Sell Item | (product) |
 *        OLD: Metrics | Sales Qty | Waste Qty | Std Unit Cost | Invoice Cost
 *        NEW:           Sales Qty | Waste Qty | Std Unit Cost | Invoice Cost
 * ------------------------------------------------------------------ */

import ExcelJS from "exceljs";

export type ColesRow = {
  /** 1-based row number in the sheet, so a reject can be pointed at. */
  rowNo: number;
  saleDate: string; // YYYY-MM-DD
  /** Coles location code, normalised — see normaliseCode. */
  location: string;
  /** Coles "Sell Item" product code, normalised. */
  sellItem: string;
  salesQty: number;
  wasteQty: number | null;
  invoiceCost: number | null;
};

export type ColesReject = { rowNo: number; reason: string; raw: Record<string, unknown> };

export type ColesParse = {
  sheetName: string;
  headerRow: number;
  /** Which header we matched each field to — surfaced in the UI so a silent
   *  mis-map is visible rather than something you find out about in a month. */
  columns: Record<string, string>;
  rows: ColesRow[];
  rejects: ColesReject[];
  rowsRead: number;
  dateFrom: string | null;
  dateTo: string | null;
};

/* ---------------------------------------------------------------- *
 * Header matching. Each field lists the spellings we accept, lowest
 * common denominator first. Compared after lowercasing and stripping
 * everything that isn't a letter or digit, so "Sales Qty", "SalesQty",
 * "Sales_Qty" and "SALES QTY." are all the same header.
 * ---------------------------------------------------------------- */
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const FIELDS: { key: keyof ColesRow | "storeDesc" | "productDesc" | "state"; names: string[]; required: boolean }[] = [
  { key: "saleDate", names: ["day", "date", "transactiondate", "saledate"], required: true },
  { key: "state", names: ["state"], required: false },
  { key: "location", names: ["location", "locationcode", "site", "store", "storenumber"], required: true },
  { key: "storeDesc", names: ["locationdescription", "storename", "sitename", "description"], required: false },
  { key: "sellItem", names: ["sellitem", "item", "itemcode", "article", "productcode"], required: true },
  { key: "productDesc", names: ["sellitemdescription", "itemdescription", "productdescription", "product"], required: false },
  { key: "salesQty", names: ["salesqty", "salesquantity", "qtysold", "unitssold", "soldqty"], required: true },
  { key: "wasteQty", names: ["wasteqty", "wastequantity", "wastage"], required: false },
  { key: "invoiceCost", names: ["invoicecost", "invoicecostaud", "invoicevalue", "invoice"], required: false },
];

/**
 * Codes arrive as text in the old report and as NUMBERS in the new one
 * (`'706'` became `706`), and our own `stores.supplier_code` is zero-padded
 * text — `0819` for Coles Lake Haven. Compared naively, `'0819' <> 819` and
 * that one store silently contributes nothing: a feed that runs, succeeds, and
 * quietly drops a store. Exactly the failure mode this whole exercise exists
 * to remove. So every code is reduced to the same canonical form at both ends:
 * digits only, leading zeros stripped.
 */
export function normaliseCode(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (/^\d+$/.test(s)) return String(Number(s)); // 0819 -> 819, 706 -> 706
  return s.toUpperCase();
}

/** Excel dates arrive as a Date, a serial number, or a string. Take all three. */
function toISODate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) {
    // ExcelJS hands back a UTC-midnight Date for a date-formatted cell.
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    // Excel serial: days since 1899-12-30 (the 1900 leap-year bug included).
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); // AU: d/m/Y
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function toNumber(v: unknown): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  // Their total rows carry '-- in Std Unit Cost; strip currency and commas.
  const s = String(v).replace(/[$,\s]/g, "").replace(/^'+/, "");
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Cell value, unwrapping the shapes ExcelJS uses for formulas and rich text. */
function cell(v: unknown): unknown {
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("result" in o) return o.result;
    if ("text" in o) return o.text;
    if ("richText" in o && Array.isArray(o.richText)) {
      return (o.richText as { text: string }[]).map((r) => r.text).join("");
    }
  }
  return v;
}

/** A subtotal line, not a data line. Both files carry per-store `Total` rows
 *  AND a final `Grand Total`. Their loader excluded only the latter. */
function isTotalRow(vals: Record<string, unknown>): boolean {
  const probe = [vals.sellItem, vals.saleDate, vals.location, vals.productDesc];
  return probe.some((v) => /^\s*(grand\s+)?total\s*$/i.test(String(v ?? "")));
}

const MAX_HEADER_SCAN = 25;

export async function parseColesWorkbook(buf: ArrayBuffer | Buffer): Promise<ColesParse> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as ArrayBuffer);

  // Find the sheet AND the header row together: the best-scoring header row
  // across every sheet wins. Their tab was renamed from "Daily Bakery Supplier
  // Report" to "Pay on Scan - Daily Report" in the same change that broke the
  // load, so matching on the name would have been one more thing to break.
  let best: { sheet: ExcelJS.Worksheet; row: number; map: Record<string, number>; score: number } | null = null;

  wb.eachSheet((sheet) => {
    const limit = Math.min(sheet.rowCount, MAX_HEADER_SCAN);
    for (let r = 1; r <= limit; r++) {
      const row = sheet.getRow(r);
      const headers: string[] = [];
      row.eachCell({ includeEmpty: true }, (c, i) => { headers[i] = norm(cell(c.value)); });

      const map: Record<string, number> = {};
      let score = 0;
      for (const f of FIELDS) {
        const idx = headers.findIndex((h) => h && f.names.includes(h));
        if (idx > 0) { map[f.key as string] = idx; score += f.required ? 2 : 1; }
      }
      const hasAllRequired = FIELDS.filter((f) => f.required).every((f) => map[f.key as string] != null);
      if (hasAllRequired && (!best || score > best.score)) best = { sheet, row: r, map, score };
    }
  });

  if (!best) {
    const missing = FIELDS.filter((f) => f.required).map((f) => f.names[0]).join(", ");
    throw new Error(
      `Couldn't find a header row in this workbook. Every sheet was checked for its column names; ` +
      `we need at least: ${missing}. If Coles have renamed a column, tell us what it's called now — ` +
      `nothing has been loaded.`,
    );
  }

  const { sheet, row: headerRow, map } = best as { sheet: ExcelJS.Worksheet; row: number; map: Record<string, number>; score: number };

  // Report back which real header we bound each field to. A mis-map that
  // "works" is the dangerous kind, so it goes on screen.
  const columns: Record<string, string> = {};
  const hdr = sheet.getRow(headerRow);
  for (const [k, i] of Object.entries(map)) columns[k] = String(cell(hdr.getCell(i).value) ?? "").trim();

  const rows: ColesRow[] = [];
  const rejects: ColesReject[] = [];
  let rowsRead = 0;
  let dateFrom: string | null = null;
  let dateTo: string | null = null;

  for (let r = headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const get = (k: string) => (map[k] == null ? undefined : cell(row.getCell(map[k]).value));

    const raw: Record<string, unknown> = {};
    for (const k of Object.keys(map)) raw[k] = get(k);

    // Entirely blank line — spacers are normal, not an error.
    if (Object.values(raw).every((v) => v == null || v === "")) continue;

    // Skip FIRST, then count. Both Coles layouts carry a per-store `Total`
    // row plus a `Grand Total`, and these were being counted as read, never
    // staged and never rejected — roughly 115 phantom rows per file, on the
    // one page whose whole point is that read = loaded + not loaded.
    if (isTotalRow(raw)) continue;
    rowsRead++;

    const saleDate = toISODate(raw.saleDate);
    const location = normaliseCode(raw.location);
    const sellItem = normaliseCode(raw.sellItem);
    const salesQty = toNumber(raw.salesQty);

    const why: string[] = [];
    if (!saleDate) why.push(`date "${String(raw.saleDate ?? "")}" not understood`);
    if (!location) why.push("no store location code");
    if (!sellItem) why.push("no product (Sell Item) code");
    if (salesQty == null) why.push(`sales quantity "${String(raw.salesQty ?? "")}" is not a number`);

    if (why.length) { rejects.push({ rowNo: r, reason: why.join("; "), raw }); continue; }

    if (!dateFrom || saleDate! < dateFrom) dateFrom = saleDate!;
    if (!dateTo || saleDate! > dateTo) dateTo = saleDate!;

    rows.push({
      rowNo: r,
      saleDate: saleDate!,
      location,
      sellItem,
      // Negative quantities are credits/returns in their reports. Clamped at
      // load, exactly as the 24 Aug historical load did, so the two agree.
      salesQty: Math.max(0, Math.round(salesQty!)),
      wasteQty: toNumber(raw.wasteQty),
      invoiceCost: toNumber(raw.invoiceCost),
    });
  }

  return { sheetName: sheet.name, headerRow, columns, rows, rejects, rowsRead, dateFrom, dateTo };
}
