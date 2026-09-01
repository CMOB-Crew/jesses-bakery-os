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

import { Readable } from "node:stream";
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
  // `calendarday` is the Woolworths daily report. `transactiondate` is their
  // RCTI. `week` is deliberately ABSENT: the Coles weekly report stamps a
  // whole week onto one date, and accepting it here would write seven days of
  // sales onto a single Monday. It gets its own message below instead.
  { key: "saleDate", names: ["day", "date", "transactiondate", "saledate", "calendarday"], required: true },
  { key: "state", names: ["state"], required: false },
  { key: "location", names: ["location", "locationcode", "site", "siteno", "store", "storenumber"], required: true },
  { key: "storeDesc", names: ["locationdescription", "storename", "sitename", "sitedescription", "description"], required: false },
  { key: "sellItem", names: ["sellitem", "item", "itemcode", "article", "articleno", "productcode"], required: true },
  { key: "productDesc", names: ["sellitemdescription", "itemdescription", "productdescription", "articledescription", "product"], required: false },
  // The RCTI repeats (Unit Cost, Quantity Settled, Extended Cost) FOUR times.
  // Only the first triplet is the sale; the other three are adjustment columns
  // and on the 1 Sept file they total -3, 0 and +3. findIndex takes the first
  // match, which is the right one -- relied on deliberately, not by accident.
  { key: "salesQty", names: ["salesqty", "salesquantity", "salesqtybuom", "quantitysettled", "qtysold", "unitssold", "soldqty"], required: true },
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
  // 20260824 -- the RCTI's format. This has to come BEFORE the Excel serial
  // branch below: read as a serial, 20260824 is a date roughly 55,000 years
  // from now. Bounded to plausible years so a real serial cannot match.
  if (typeof v === "number" && Number.isInteger(v) && v >= 19000101 && v <= 29991231) {
    const y = Math.floor(v / 10000), mo = Math.floor(v / 100) % 100, d = v % 100;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    // Excel serial: days since 1899-12-30 (the 1900 leap-year bug included).
    const ms = Math.round((v - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  // "20260824" as text, which is how it arrives from the RCTI once it is a
  // CSV. Without this it falls through to new Date("20260824"), which is an
  // Invalid Date, and every row in the file is rejected for a bad date.
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
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

/** RFC4180 enough for a supplier report: quoted fields, doubled quotes inside
 *  them, CRLF or LF. Written out rather than pulled in as a dependency, and
 *  not a naive split(","): the RCTI's Site Name is free text, and one comma in
 *  a store name would shift every column after it by one -- silently, into the
 *  wrong field, which is worse than failing. */
function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ",") { row.push(field.trim()); field = ""; continue; }
    if (ch === "\r") continue;
    if (ch === "\n") { row.push(field.trim()); rows.push(row); row = []; field = ""; continue; }
    field += ch;
  }
  if (field !== "" || row.length) { row.push(field.trim()); rows.push(row); }
  return rows;
}


/* ------------------------------------------------------------------ *
 * Read the workbook WITHOUT materialising every empty cell in it.
 *
 * Woolworths' "by Day by Store by Material" export is 4.9MB zipped and
 * 56.8MB of XML once open, because sheet `e` is declared 100,501 rows long
 * and only 647 of those carry a value -- the formatting was dragged to the
 * bottom of the sheet and every one of those empty cells is written out.
 *
 * wb.xlsx.load() builds an object for all of them. Measured on the real file,
 * on the same exceljs 4.4.0 the site builds with:
 *
 *     wb.xlsx.load()   8,377 ms   RSS 1,097 MB
 *     streamed         4,334 ms   RSS   276 MB
 *
 * A Netlify function is given 1,024 MB. So this file never failed to parse --
 * the parser ran out of room to parse it in and the function was killed, and
 * a killed function answers with the platform's JSON rather than ours, which
 * is why /feeds showed "Nothing was loaded." followed by nothing at all.
 *
 * The streaming reader hands back one row at a time and never holds the sheet.
 * Rows with no values are dropped as they go past; the rest are rebuilt into a
 * normal worksheet AT THEIR ORIGINAL ROW NUMBERS, so everything below is
 * unchanged -- the header scan, the row-count tie-break between sheets `e` and
 * `cs`, and the `rowNo` on a reject, which still points at the line of the
 * spreadsheet the person is looking at.
 *
 * Checked against all four real files: same sheet, same header row, same
 * column map, same counts, same units, same dates, same row numbers.
 * ------------------------------------------------------------------ */
async function loadSheetsThatHaveRows(wb: ExcelJS.Workbook, bytes: Uint8Array): Promise<void> {
  const stream = Readable.from(Buffer.from(bytes));
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(stream, {
    entries: "emit",
    sharedStrings: "cache",
    worksheets: "emit",
    // The styles are the bulk of those 56.8MB and nothing here reads them.
    styles: "ignore",
    hyperlinks: "ignore",
  });

  for await (const incoming of reader) {
    // exceljs types WorksheetReader without `name`, though it carries one at
    // runtime -- the sheet names ("e", "cs", "Input") come from here.
    const sheetName = (incoming as unknown as { name?: string }).name;
    const ws = wb.addWorksheet(sheetName || `Sheet${wb.worksheets.length + 1}`);
    for await (const row of incoming) {
      const values = row.values as unknown[];
      if (!Array.isArray(values)) continue;
      let any = false;
      for (let i = 1; i < values.length; i++) {
        const v = values[i];
        if (v !== null && v !== undefined && String(cell(v) ?? "").trim() !== "") { any = true; break; }
      }
      if (!any) continue;
      const target = ws.getRow(row.number);
      for (let i = 1; i < values.length; i++) {
        const v = values[i];
        if (v !== null && v !== undefined) target.getCell(i).value = v as ExcelJS.CellValue;
      }
      target.commit();
    }
  }
}

const MAX_HEADER_SCAN = 25;

export async function parseColesWorkbook(buf: ArrayBuffer | Buffer): Promise<ColesParse> {
  const wb = new ExcelJS.Workbook();

  // An .xlsx is a zip archive and starts "PK". Anything else is text, and
  // ExcelJS answers a CSV with JSZip's "Can't find end of central directory",
  // which is what stopped the Woolworths RCTI. Rather than a second parser,
  // the rows are read into a worksheet so the header scan, the total-row
  // filter, the code normaliser and every other rule below apply unchanged.
  const bytes = new Uint8Array(buf as ArrayBuffer);
  const isZip = bytes.length > 1 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (isZip) {
    await loadSheetsThatHaveRows(wb, bytes);
  } else {
    const text = new TextDecoder("utf-8").decode(bytes).replace(/^\uFEFF/, "");
    const ws = wb.addWorksheet("csv");
    for (const line of splitCsv(text)) ws.addRow(line);
  }

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
      // On an equal score, prefer the sheet with more rows. The Woolworths
      // workbook carries sheet `e` (646 rows) and sheet `cs` (500) with
      // IDENTICAL headers, and `cs` is a strict subset of `e` -- same keys,
      // same quantities, checked row by row. Today `e` wins only because it
      // comes first and the test is a strict `>`. If their export ever
      // reorders the tabs, that silently loads 75% of the data and reports
      // success. This makes the right sheet the deliberate choice.
      if (hasAllRequired && (!best || score > best.score ||
          (score === best.score && sheet.rowCount > best.sheet.rowCount))) {
        best = { sheet, row: r, map, score };
      }
    }
  });

  if (!best) {
    // The Coles WEEKLY report reaches here, and "couldn't find a header row"
    // tells the person nothing. It is a real report, correctly sent -- it just
    // carries a week per row instead of a day, and there is no honest way to
    // turn one number into seven. Say so.
    let sawWeek = false;
    wb.eachSheet((sheet) => {
      const limit = Math.min(sheet.rowCount, MAX_HEADER_SCAN);
      for (let r = 1; r <= limit; r++) {
        const headers: string[] = [];
        sheet.getRow(r).eachCell({ includeEmpty: true }, (c, i) => { headers[i] = norm(cell(c.value)); });
        if (headers.includes("week") && headers.some((h) => h === "salesqty" || h === "sellitem")) sawWeek = true;
      }
    });
    if (sawWeek) {
      throw new Error(
        "This is the WEEKLY Pay on Scan report -- each row is a whole week's sales " +
        "on one date, not a day at a time. Loading it would record a week as a single " +
        "Monday. Please send the DAILY report instead. Nothing has been loaded.",
      );
    }
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
