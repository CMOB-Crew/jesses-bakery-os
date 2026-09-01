"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

/* ------------------------------------------------------------------ *
 * Upload a retailer sales report.
 *
 * The Coles feed is a person opening a spreadsheet and dropping it somewhere.
 * Today that somewhere is Jesse's blob storage, where a pipeline reads a fixed
 * cell range out of it and has read nothing since 3 August while reporting
 * Success. This is the same act, pointed at us instead.
 *
 * The whole design goal of this screen is that it is IMPOSSIBLE to walk away
 * from it believing something loaded when it didn't. So:
 *   - the result names the sheet and the header row we found, and which real
 *     column we bound each field to. A mis-map that still "works" is the
 *     dangerous kind, so it is on screen every time rather than in a log.
 *   - rows that didn't load are listed with their row number in the sheet and
 *     a reason in plain words. Not a count. The rows.
 *   - a file we can't read is refused outright, before anything is written.
 * ------------------------------------------------------------------ */

type Reject = { rowNo: number; reason: string };
type Result = {
  ok: true;
  filename: string; sheetName: string; headerRow: number;
  columns: Record<string, string>;
  periodFrom: string | null; periodTo: string | null;
  rowsRead: number; rowsLoaded: number; rowsRejected: number;
  rejects: Reject[];
} | { ok: false; error: string };

const nf = (n: number) => (Number(n) || 0).toLocaleString("en-AU");
const FIELD_LABEL: Record<string, string> = {
  saleDate: "Date", location: "Store code", sellItem: "Product code",
  salesQty: "Units sold", wasteQty: "Waste", invoiceCost: "Revenue",
  state: "State", storeDesc: "Store name", productDesc: "Product name",
};
const fmtDay = (d: string | null) =>
  d ? new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" }).format(new Date(d + "T00:00:00")) : "—";

const RETAILERS: { id: string; label: string; report: string }[] = [
  { id: "coles", label: "Coles", report: "Pay On Scan" },
  { id: "woolworths", label: "Woolworths", report: "supplier sales" },
  { id: "harris_farm", label: "Harris Farm", report: "vendor sales" },
];

export default function FeedUpload() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Which retailer this file belongs to. The loader resolves store and
  // product codes from the retailer's own columns, so picking the wrong
  // one does not mis-load: every row comes back as an unknown code.
  const [retailer, setRetailer] = useState("coles");
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const [res, setRes] = useState<Result | null>(null);

  async function send(file: File) {
    setBusy(true);
    setRes(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch(`/api/feeds/${retailer}`, { method: "POST", body: fd });
      const j = (await r.json()) as Result;
      setRes(j);
      if (j.ok) router.refresh();
    } catch {
      setRes({ ok: false, error: "Couldn't reach the server. Nothing was loaded — try again." });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  return (
    <div className="fu">
      <div className="fu-pick" role="group" aria-label="Which retailer sent this report">
        {RETAILERS.map((r) => (
          <button
            key={r.id}
            type="button"
            className={retailer === r.id ? "on" : ""}
            onClick={() => { setRetailer(r.id); setRes(null); }}
            disabled={busy}
          >{r.label}</button>
        ))}
      </div>

      <div
        className={`fu-drop${drag ? " on" : ""}${busy ? " busy" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault(); setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f && !busy) send(f);
        }}
        onClick={() => !busy && fileRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !busy) fileRef.current?.click(); }}
      >
        <input
          ref={fileRef}
          type="file"
          // .csv is here for the Woolworths RCTI, which Woolworths genuinely
          // send as a CSV. Without it the file is invisible in the picker,
          // while dragging the very same file onto this box works -- the
          // server has accepted CSVs since de9a0cc. Same file, two answers,
          // depending only on how you handed it over.
          accept=".xlsx,.xlsm,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) send(f); }}
        />
        {busy ? (
          <>
            <div className="fu-t">Reading the file…</div>
            <div className="fu-s">Nothing is written until every row has been checked.</div>
          </>
        ) : (
          <>
            <div className="fu-t">
              Drop the {RETAILERS.find((r) => r.id === retailer)?.label}{" "}
              <b>{RETAILERS.find((r) => r.id === retailer)?.report}</b> report here
            </div>
            <div className="fu-s">or click to choose it · .xlsx or .csv, up to 25MB</div>
          </>
        )}
      </div>

      <p className="fu-note">
        We read the columns by their <b>names</b>, not their positions — so if a retailer moves a
        column or renames the tab, this keeps working. Any row we can&apos;t match to a
        store and a product is listed back to you rather than quietly skipped.
        {retailer !== "coles" && (
          <> Only Coles reports have been through this parser so far; if this one is
          shaped differently it will be refused with a reason, never half-loaded.</>
        )}
      </p>

      {res && !res.ok && (
        <div className="fu-err">
          <b>Nothing was loaded.</b> {res.error}
        </div>
      )}

      {res && res.ok && (
        <div className={`fu-res${res.rowsRejected > 0 ? " part" : ""}`}>
          <div className="fu-h">
            <span className={`fu-pill ${res.rowsRejected > 0 ? "amber" : "green"}`}>
              {res.rowsRejected > 0 ? "Loaded, with exceptions" : "Loaded"}
            </span>
            <span className="fu-fn">{res.filename}</span>
            <span className="fu-per">{fmtDay(res.periodFrom)} → {fmtDay(res.periodTo)}</span>
          </div>

          <div className="fu-nums">
            <span><b>{nf(res.rowsLoaded)}</b> rows loaded</span>
            <span className={res.rowsRejected > 0 ? "bad" : ""}>
              <b>{nf(res.rowsRejected)}</b> not loaded
            </span>
            <span className="dim"><b>{nf(res.rowsRead)}</b> read from the sheet</span>
          </div>

          <details className="fu-map">
            <summary>
              Read from <b>{res.sheetName}</b>, headers on row {res.headerRow} — check the column match
            </summary>
            <div className="fu-cols">
              {Object.entries(res.columns).map(([k, v]) => (
                <div key={k}><span>{FIELD_LABEL[k] ?? k}</span><b>{v}</b></div>
              ))}
            </div>
          </details>

          {res.rejects.length > 0 && (
            <div className="fu-rej">
              <div className="fu-rh">
                These rows didn&apos;t load. Row numbers are the sheet&apos;s own.
              </div>
              <ul>
                {res.rejects.map((r) => (
                  <li key={r.rowNo}><span className="rn">Row {r.rowNo}</span>{r.reason}</li>
                ))}
              </ul>
              {res.rowsRejected > res.rejects.length && (
                <div className="fu-more">
                  …and {nf(res.rowsRejected - res.rejects.length)} more. The first 200 are shown.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <style>{`
        .fu{display:block}
        .fu .fu-pick{display:flex;gap:8px;margin-bottom:12px}
        .fu .fu-pick button{font-family:inherit;font-size:13px;font-weight:600;color:var(--ink2);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:7px 15px;cursor:pointer}
        .fu .fu-pick button.on{background:var(--espresso);border-color:var(--espresso);color:#f4ecd9}
        .fu .fu-pick button:disabled{opacity:.5;cursor:not-allowed}
        .fu .fu-drop{border:2px dashed var(--line);border-radius:var(--r);background:var(--card);padding:34px 20px;text-align:center;cursor:pointer;transition:border-color .15s,background .15s}
        .fu .fu-drop:hover,.fu .fu-drop.on{border-color:var(--crust);background:#fdfaf4}
        .fu .fu-drop.busy{cursor:progress;opacity:.75}
        .fu .fu-t{font-family:var(--serif);font-size:17px;font-weight:600}
        .fu .fu-s{font-size:12.5px;color:var(--muted);margin-top:6px}
        .fu .fu-note{font-size:12.5px;color:var(--muted);line-height:1.6;margin:12px 2px 0}
        .fu .fu-note b{color:var(--ink2);font-weight:600}

        .fu .fu-err{margin-top:16px;background:var(--red-b);border:1px solid #eab9a8;border-left:3px solid var(--red);color:var(--red-t);border-radius:11px;padding:12px 15px;font-size:13.5px;line-height:1.55}

        .fu .fu-res{margin-top:16px;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--green);border-radius:var(--r);padding:16px 18px}
        .fu .fu-res.part{border-left-color:var(--amber)}
        .fu .fu-h{display:flex;align-items:center;gap:11px;flex-wrap:wrap;margin-bottom:12px}
        .fu .fu-pill{font-size:11px;font-weight:800;letter-spacing:.4px;text-transform:uppercase;padding:4px 10px;border-radius:999px}
        .fu .fu-pill.green{background:var(--green-b);color:var(--green-t)}
        .fu .fu-pill.amber{background:var(--amber-b);color:var(--amber-t)}
        .fu .fu-fn{font-weight:600;font-size:13.5px}
        .fu .fu-per{margin-left:auto;font-size:12.5px;color:var(--muted)}

        .fu .fu-nums{display:flex;gap:22px;flex-wrap:wrap;font-size:13.5px;color:var(--ink2);padding-bottom:12px;border-bottom:1px solid var(--line2)}
        .fu .fu-nums b{font-family:var(--serif);font-size:19px;font-weight:600;margin-right:5px;font-variant-numeric:tabular-nums}
        .fu .fu-nums .bad b{color:var(--amber-t)}
        .fu .fu-nums .dim{color:var(--muted)}

        .fu .fu-map{margin-top:12px;font-size:12.5px}
        .fu .fu-map summary{cursor:pointer;color:var(--ink2)}
        .fu .fu-map summary b{font-weight:600}
        .fu .fu-cols{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:6px 16px;margin-top:10px}
        .fu .fu-cols div{display:flex;justify-content:space-between;gap:10px;padding:5px 9px;background:var(--surface);border-radius:7px}
        .fu .fu-cols span{color:var(--muted)}
        .fu .fu-cols b{font-weight:600}

        .fu .fu-rej{margin-top:14px;border-top:1px solid var(--line2);padding-top:12px}
        .fu .fu-rh{font-size:12.5px;color:var(--muted);margin-bottom:8px}
        .fu .fu-rej ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:5px;max-height:260px;overflow-y:auto}
        .fu .fu-rej li{font-size:12.5px;line-height:1.5;padding:6px 10px;background:var(--amber-b);border-radius:7px;color:var(--amber-t)}
        .fu .fu-rej .rn{display:inline-block;min-width:64px;font-weight:700;font-variant-numeric:tabular-nums}
        .fu .fu-more{font-size:12px;color:var(--muted);margin-top:8px}
      `}</style>
    </div>
  );
}
