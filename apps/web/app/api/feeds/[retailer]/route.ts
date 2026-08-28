import { NextRequest, NextResponse } from "next/server";
import { runAsUser, sql as sqlClient } from "@/lib/db";
import { getSessionClaims } from "@/lib/supabase/server";
import { AUTH_ENFORCED } from "@/lib/auth";

/** The tagged-template client, whether it is the shared connection or a
 *  claims-carrying transaction. Same API either way. */
type SqlClient = typeof sqlClient;
import { parseColesWorkbook, type ColesReject } from "@/lib/feeds/coles";

export const dynamic = "force-dynamic";
// A week of Coles is ~8k rows; a month is ~35k. Give it room but not forever.
export const maxDuration = 60;

/* ------------------------------------------------------------------ *
 * Take a Coles "Pay On Scan" report and load it.
 *
 * The contract, and the reason this exists at all: every row in the file
 * either lands in sales_daily or comes back with a reason. There is no third
 * outcome, and there is no partial success reported as success. Their pipeline
 * read this same file into silence for three weeks and said Success 259,303
 * times while doing it.
 *
 * Deliberately NOT chunked into a background job. Simona uploads a file and
 * watches it land — if it takes twelve seconds, that is twelve seconds she
 * spends knowing whether her data is in. A queue would take the answer away
 * from the moment she needs it.
 * ------------------------------------------------------------------ */

const MAX_BYTES = 25 * 1024 * 1024;

/* A file the person can act on, instead of the library's internals.
 *
 * An .xlsx is a zip archive, so when a PDF arrives ExcelJS hands back JSZip's
 * "Can't find end of central directory : is this a zip file ?" complete with a
 * link to JSZip's docs. That went on screen verbatim. The reader is Simona at
 * 6am trying to get her sales in, not a JavaScript developer. */
const SPREADSHEET = /\.(xlsx|xlsm)$/i;

function wrongTypeMessage(filename: string): string | null {
  if (SPREADSHEET.test(filename)) return null;
  const ext = (filename.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  const named = ext ? `a .${ext} file` : "a file with no extension";
  const why =
    ext === "pdf"
      ? " A PDF is a picture of the numbers; we have to read them cell by cell."
      : ext === "csv" || ext === "txt"
        ? " Save it as .xlsx from Excel rather than exporting to text."
        : "";
  return `That is ${named}. It needs to be the Excel file the retailer sends -- a .xlsx.${why} If you opened the report and re-saved it, send the original instead.`;
}

function friendlyParseError(e: unknown, filename: string): string {
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


// The three retailers whose sales we ingest. 'invoice' is in the enum but
// has no report -- those are Jesse's own accounts, billed not scanned.
const RETAILERS = new Set(["coles", "woolworths", "harris_farm"]);

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ retailer: string }> },
) {
  // RLS. Every page goes through withUser(), and every write action imports
  // `q as sql`; both inject the verified claims transaction-locally. This
  // route used the raw client, so request.jwt.claims was never set,
  // current_app_role() was null, and migration 039's policy refused the very
  // first insert -- for every file, every retailer, every time. Nothing had
  // ever loaded through here, and nothing could have.
  const claims = AUTH_ENFORCED ? await getSessionClaims() : null;
  if (AUTH_ENFORCED && !claims) {
    return NextResponse.json(
      { ok: false, error: "Your session has expired. Sign in again and re-send the file." },
      { status: 401 },
    );
  }
  // One transaction for the whole load, so a crash cannot leave rows staged
  // or half-merged. The handler still catches its own errors and RETURNS,
  // so the transaction commits and the 'failed' audit row survives.
  return claims
    ? runAsUser(claims, (tx) => handle(req, ctx, tx))
    : handle(req, ctx, sqlClient);
}

// The third parameter is deliberately named `sql`: every statement below is
// unchanged from before this fix and now resolves to the client passed in,
// including the two postgres.js bulk-insert helpers that q() cannot express.
async function handle(
  req: NextRequest,
  { params }: { params: Promise<{ retailer: string }> },
  sql: SqlClient,
) {
  let uploadId: string | null = null;
  try {
    // Validated against a fixed set, never passed through to SQL as-is.
    const { retailer } = await params;
    if (!RETAILERS.has(retailer)) {
      return NextResponse.json(
        { ok: false, error: `Unknown retailer "${retailer}".` },
        { status: 400 },
      );
    }
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "No file was attached." }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json(
        { ok: false, error: `That file is ${(file.size / 1048576).toFixed(1)}MB — the limit is 25MB.` },
        { status: 400 },
      );
    }

    // Caught before a byte is read: the common case is somebody opened the
    // report and re-saved it as something else.
    const wrongType = wrongTypeMessage(file.name);
    if (wrongType) {
      return NextResponse.json({ ok: false, error: wrongType }, { status: 400 });
    }

    // ---- parse first, write nothing yet -------------------------------
    // A file we can't read must not leave a half-written upload behind.
    let parsed;
    try {
      parsed = await parseColesWorkbook(await file.arrayBuffer());
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: friendlyParseError(e, file.name) },
        { status: 400 },
      );
    }

    if (parsed.rows.length === 0 && parsed.rejects.length === 0) {
      return NextResponse.json(
        { ok: false, error: `Found the headers on row ${parsed.headerRow} of "${parsed.sheetName}", but there were no data rows underneath. Nothing has been loaded.` },
        { status: 400 },
      );
    }

    // ---- record the upload --------------------------------------------
    const [up] = await sql<{ id: string }[]>`
      insert into feed_uploads
        (retailer, filename, sheet_name, header_row, column_map, period_from, period_to, rows_read)
      values (${retailer}::retailer_type, ${file.name}, ${parsed.sheetName}, ${parsed.headerRow},
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
    // — so a row the parser could not read vanished without trace and the page
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

    return NextResponse.json({
      ok: true,
      uploadId,
      filename: file.name,
      sheetName: parsed.sheetName,
      headerRow: parsed.headerRow,
      columns: parsed.columns,
      periodFrom: parsed.dateFrom,
      periodTo: parsed.dateTo,
      rowsRead: parsed.rowsRead,
      rowsLoaded: Number(counts?.rows_loaded ?? res?.loaded ?? 0),
      rowsRejected: Number(counts?.rows_rejected ?? 0),
      rejects: rejects.map((r) => ({ rowNo: r.row_no, reason: r.reason })),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Something went wrong loading that file.";
    // Mark the upload failed rather than leaving it looking half-done.
    if (uploadId) {
      try {
        await sql`update feed_uploads set status='failed', error=${msg} where id=${uploadId}::uuid`;
        await sql`delete from feed_staging where upload_id = ${uploadId}::uuid`;
      } catch { /* the original error is the one that matters */ }
    }
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
