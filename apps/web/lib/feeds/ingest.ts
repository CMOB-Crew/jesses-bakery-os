import "server-only";
import { sql as sqlClient } from "@/lib/db";
import { parseColesWorkbook, type ColesReject } from "@/lib/feeds/coles";

// ---------------------------------------------------------------------------
// One workbook in, one audit row and a merge out.
//
// Lifted verbatim out of app/api/feeds/[retailer]/route.ts when the mailbox
// poller arrived, so that the file Simona uploads by hand and the file we pull
// out of the mailbox at 9am go through the SAME code. A second copy of the
// loader is the kind of thing that stays in step for a fortnight and then
// quietly does not.
//
// The contract has not changed and is the whole point of this pipeline: every
// row in the file either lands in sales_daily or comes back with a reason.
// There is no third outcome, and no partial success reported as success. Their
// old pipeline read this same file into silence for three weeks and said
// Success 259,303 times while doing it.
// ---------------------------------------------------------------------------

/** The tagged-template client, whether it is the shared connection or a
 *  claims-carrying transaction. Same API either way. */
export type SqlClient = typeof sqlClient;

/* A file the person can act on, instead of the library's internals.
 *
 * An .xlsx is a zip archive, so when a PDF arrives ExcelJS hands back JSZip's
 * "Can't find end of central directory : is this a zip file ?" complete with a
 * link to JSZip's docs. That went on screen verbatim. The reader is Simona at
 * 6am trying to get her sales in, not a JavaScript developer. */
// .csv is here for the Woolworths RCTI, which is genuinely a CSV -- that is
// the format Woolworths send, not something anyone re-saved.
const SPREADSHEET = /\.(xlsx|xlsm|csv)$/i;

export function wrongTypeMessage(filename: string): string | null {
  if (SPREADSHEET.test(filename)) return null;
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  const named = ext ? `a .${ext} file` : "a file with no extension";
  const why =
    ext === "pdf"
      ? " A PDF is a picture of the numbers; we have to read them cell by cell."
      : ext === "txt"
        ? " Save it as .xlsx from Excel rather than exporting to text."
        : "";
  return `That is ${named}. It needs to be the Excel file the retailer sends -- a .xlsx.${why} If you opened the report and re-saved it, send the original instead.`;
}

export function friendlyParseError(e: unknown, filename: string): string {
  const raw = e instanceof Error ? e.message : "";
  // JSZip's failure to open the container, in any of its spellings.
  if (/central directory|is this a zip|corrupted zip|end of data/i.test(raw)) {
    return (
      wrongTypeMessage(filename) ??
      "That file will not open as a spreadsheet. It may be damaged, or saved in an older .xls format -- re-save it as .xlsx and try again."
    );
  }
  // The parser's own messages were written for a person. Leave them alone.
  return raw || "That file could not be read as a spreadsheet.";
}

export type IngestResult =
  | {
      ok: true;
      uploadId: string;
      filename: string;
      sheetName: string;
      headerRow: number;
      columns: Record<string, string>;
      periodFrom: string | null;
      periodTo: string | null;
      rowsRead: number;
      rowsLoaded: number;
      rowsRejected: number;
      rejects: { rowNo: number; reason: string }[];
    }
  | { ok: false; error: string; status: number };

export async function ingestWorkbook(
  sql: SqlClient,
  retailer: string,
  filename: string,
  bytes: ArrayBuffer,
): Promise<IngestResult> {
  let uploadId: string | null = null;
  try {
    // Caught before a byte is parsed: the common case is somebody opened the
    // report and re-saved it as something else.
    const wrongType = wrongTypeMessage(filename);
    if (wrongType) return { ok: false, error: wrongType, status: 400 };

    // ---- parse first, write nothing yet -------------------------------
    // A file we can't read must not leave a half-written upload behind.
    let parsed;
    try {
      parsed = await parseColesWorkbook(bytes);
    } catch (e) {
      return { ok: false, error: friendlyParseError(e, filename), status: 400 };
    }

    if (parsed.rows.length === 0 && parsed.rejects.length === 0) {
      return {
        ok: false,
        error: `Found the headers on row ${parsed.headerRow} of "${parsed.sheetName}", but there were no data rows underneath. Nothing has been loaded.`,
        status: 400,
      };
    }

    // ---- record the upload --------------------------------------------
    const [up] = await sql<{ id: string }[]>`
      insert into feed_uploads
        (retailer, filename, sheet_name, header_row, column_map, period_from, period_to, rows_read)
      values (${retailer}::retailer_type, ${filename}, ${parsed.sheetName}, ${parsed.headerRow},
              ${JSON.stringify(parsed.columns)}::jsonb,
              ${parsed.dateFrom}, ${parsed.dateTo}, ${parsed.rowsRead})
      returning id`;
    uploadId = up.id;

    // ---- stage the readable rows --------------------------------------
    // Batched: one statement per 2,000 rows keeps the parameter count and the
    // statement size sane on the pooler without turning into 8,000 round trips.
    const CHUNK = 2000;
    for (let i = 0; i < parsed.rows.length; i += CHUNK) {
      const slice = parsed.rows.slice(i, i + CHUNK).map((r) => ({
        upload_id: uploadId,
        row_no: r.rowNo,
        sale_date: r.saleDate,
        location: r.location,
        sell_item: r.sellItem,
        sales_qty: r.salesQty,
        waste_qty: r.wasteQty,
        invoice_cost: r.invoiceCost,
      }));
      await sql`insert into feed_staging ${sql(slice)}`;
    }

    // ---- the parser's own rejects go in the same place as the loader's --
    // so "show me what didn't load" is one list, not two.
    //
    // Tagged source:'parser' since 047. They are written BEFORE the loader
    // runs, and the loader used to open with an untagged
    // `delete from feed_rejects where upload_id = ...` that took these with it
    // -- so a row the parser could not read vanished without trace and the page
    // printed "Not loaded: 0". It now clears only source='loader'.
    if (parsed.rejects.length) {
      for (let i = 0; i < parsed.rejects.length; i += CHUNK) {
        const slice = parsed.rejects.slice(i, i + CHUNK).map((r: ColesReject) => ({
          upload_id: uploadId,
          row_no: r.rowNo,
          reason: r.reason,
          raw: JSON.stringify(r.raw),
          source: "parser",
        }));
        await sql`insert into feed_rejects ${sql(slice)}`;
      }
    }

    // ---- resolve and merge --------------------------------------------
    const [res] = await sql<{ loaded: number; rejected: number }[]>`
      select * from jb_load_feed_upload(${uploadId}::uuid)`;

    const rejects = await sql<{ row_no: number; reason: string }[]>`
      select row_no, reason from feed_rejects
       where upload_id = ${uploadId}::uuid
       order by row_no limit 200`;

    const [counts] = await sql<{ rows_loaded: number; rows_rejected: number }[]>`
      select rows_loaded, rows_rejected from feed_uploads where id = ${uploadId}::uuid`;

    // Staging has done its job; the audit row and the rejects are what persist.
    await sql`delete from feed_staging where upload_id = ${uploadId}::uuid`;

    return {
      ok: true,
      uploadId,
      filename,
      sheetName: parsed.sheetName,
      headerRow: parsed.headerRow,
      columns: parsed.columns,
      periodFrom: parsed.dateFrom,
      periodTo: parsed.dateTo,
      rowsRead: parsed.rowsRead,
      rowsLoaded: Number(counts?.rows_loaded ?? res?.loaded ?? 0),
      rowsRejected: Number(counts?.rows_rejected ?? 0),
      rejects: rejects.map((r) => ({ rowNo: r.row_no, reason: r.reason })),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Something went wrong loading that file.";
    // Mark the upload failed rather than leaving it looking half-done.
    if (uploadId) {
      try {
        await sql`update feed_uploads set status='failed', error=${msg} where id=${uploadId}::uuid`;
        await sql`delete from feed_staging where upload_id = ${uploadId}::uuid`;
      } catch { /* the original error is the one that matters */ }
    }
    return { ok: false, error: msg, status: 500 };
  }
}
