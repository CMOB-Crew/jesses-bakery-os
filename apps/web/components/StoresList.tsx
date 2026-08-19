"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import StatusTag from "@/components/StatusTag";
import type { StoreWeek, Status } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Stores directory — the searchable, filterable list of every active
 * store. Live from v_store_week. An unfiltered 265-row table is hard to
 * work; this lets Simona jump to a store by name, or narrow to a region,
 * a retailer, or just the red ones, and sort by what matters. All
 * client-side over the already-fetched rows — no extra queries.
 * ------------------------------------------------------------------ */

const nf = (n: number) => (Number(n) || 0).toLocaleString("en-AU");
const num = (v: unknown) => Number(v) || 0;

// A store with nothing delivered AND nothing sold this week has no loaded data
// (Coles/Harris feeds aren't live yet). It is NOT "on track" — surface it as a
// neutral "No data" state, never green, and keep it out of the on-track count.
const hasData = (s: StoreWeek) => Number(s.total_sent) > 0 || Number(s.total_sold) > 0;
type Eff = Status | "nodata";
const effOf = (s: StoreWeek): Eff => (hasData(s) ? s.status : "nodata");
const EFF_ORDER: Record<Eff, number> = { red: 0, amber: 1, green: 2, nodata: 3 };
const EFF_LABEL: Record<Eff, string> = { red: "Needs attention", amber: "Watch", green: "On track", nodata: "No data" };

type SortKey = "status" | "waste" | "sold" | "stockouts" | "name";
const SORTS: { k: SortKey; label: string }[] = [
  { k: "status", label: "Worst first" },
  { k: "waste", label: "Waste %" },
  { k: "stockouts", label: "Sold out" },
  { k: "sold", label: "Units sold" },
  { k: "name", label: "Name A–Z" },
];

const retailerLabel = (r: string) =>
  r === "harris_farm" ? "Harris Farm" : r ? r[0].toUpperCase() + r.slice(1) : "—";

// Named drill-down views — each predicate matches an Overview "Needs attention"
// / "Opportunities" tally EXACTLY, so clicking a number on the dashboard lands
// on precisely those stores. Definitions must stay in lockstep with TodayDashboard.
const sellThroughOf = (s: StoreWeek) => {
  const sent = num(s.total_sent), sold = num(s.total_sold);
  return sent > 0 ? (sold / sent) * 100 : null;
};
const growthOf = (s: StoreWeek) => {
  const sold = num(s.total_sold), prev = num(s.total_sold_prev);
  return prev > 0 ? ((sold - prev) / prev) * 100 : null;
};
const VIEWS: Record<string, { label: string; test: (s: StoreWeek) => boolean }> = {
  waste30: { label: "Excessive waste (>30%)", test: (s) => s.waste_pct != null && num(s.waste_pct) > 30 },
  stockouts: { label: "Likely to sell out", test: (s) => num(s.stockout_days) > 0 },
  overdeliver: { label: "Allocation opportunities · over-delivering", test: (s) => num(s.total_sent) - num(s.total_sold) > Math.max(20, num(s.total_sold) * 0.2) },
  expandrange: { label: "Could expand range", test: (s) => { const st = sellThroughOf(s); const w = s.waste_pct == null ? null : num(s.waste_pct); return st != null && st >= 95 && (w == null || w < 12); } },
  outperform: { label: "Outperforming comparable stores", test: (s) => { const st = sellThroughOf(s); return s.status === "green" && st != null && st >= 92; } },
  declines: { label: "Abnormal sales declines", test: (s) => { const g = growthOf(s); return g != null && g < -10; } },
};

// CSV-escape a cell (quote when it contains a comma, quote, or newline).
const csvCell = (v: string | number | null) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default function StoresList({ stores, showRegion = true, initialView }: { stores: StoreWeek[]; showRegion?: boolean; initialView?: string }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | Eff>("all");
  const [region, setRegion] = useState("all");
  const [retailer, setRetailer] = useState("all");
  const [sort, setSort] = useState<SortKey>("status");
  const [view, setView] = useState(initialView && VIEWS[initialView] ? initialView : "");
  const activeView = view && VIEWS[view] ? VIEWS[view] : null;

  const regions = useMemo(
    () => [...new Set(stores.map((s) => s.region).filter(Boolean) as string[])].sort(),
    [stores],
  );
  const retailers = useMemo(
    () => [...new Set(stores.map((s) => s.retailer).filter(Boolean))].sort(),
    [stores],
  );
  const counts = useMemo(() => {
    const c: Record<Eff, number> = { red: 0, amber: 0, green: 0, nodata: 0 };
    for (const s of stores) c[effOf(s)] += 1;
    return c;
  }, [stores]);
  // The whole Stockouts column is empty until the daily feed lands — hide it
  // (and its sort) rather than show 265 dashes; it returns automatically.
  const anyStockouts = useMemo(() => stores.some((s) => num(s.stockout_days) > 0), [stores]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = stores.filter(
      (s) =>
        (!activeView || activeView.test(s)) &&
        (status === "all" || effOf(s) === status) &&
        (region === "all" || s.region === region) &&
        (retailer === "all" || s.retailer === retailer) &&
        (!term ||
          s.name.toLowerCase().includes(term) ||
          (s.region ?? "").toLowerCase().includes(term)),
    );
    return [...list].sort((a, b) => {
      switch (sort) {
        case "waste":
          return num(b.waste_pct) - num(a.waste_pct);
        case "sold":
          return num(b.total_sold) - num(a.total_sold);
        case "stockouts":
          return num(b.stockout_days) - num(a.stockout_days) || num(b.waste_pct) - num(a.waste_pct);
        case "name":
          return a.name.localeCompare(b.name);
        default:
          return EFF_ORDER[effOf(a)] - EFF_ORDER[effOf(b)] || num(b.total_wasted) - num(a.total_wasted) || num(b.total_sold) - num(a.total_sold);
      }
    });
  }, [stores, q, status, region, retailer, sort, activeView]);

  const filtered = q || status !== "all" || region !== "all" || retailer !== "all";

  // Export exactly what's on screen (current filter + sort) as CSV — Simona
  // works from spreadsheets, so the filtered view goes straight to one.
  function downloadCsv() {
    const header = ["Store", ...(showRegion ? ["Region"] : []), "Retailer", "Status", "Waste %", "Sold-out days", "Sold (wk)"];
    const body = rows.map((s) =>
      [
        s.name,
        ...(showRegion ? [s.region ?? ""] : []),
        retailerLabel(s.retailer),
        EFF_LABEL[effOf(s)],
        s.waste_pct == null ? "" : Number(s.waste_pct),
        num(s.stockout_days),
        effOf(s) === "nodata" ? "" : num(s.total_sold),
      ].map(csvCell).join(","),
    );
    const csv = [header.map(csvCell).join(","), ...body].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jesses-bakery-stores-${rows.length}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="slist">
      {activeView && (
        <div className="viewbanner">
          <span className="vb-l">Showing</span>
          <b>{activeView.label}</b>
          <span className="vb-c">{rows.length} store{rows.length === 1 ? "" : "s"}</span>
          <button className="vb-x" onClick={() => setView("")}>Show all stores ×</button>
        </div>
      )}
      <div className="chips">
        {(["all", "red", "amber", "green", "nodata"] as const).map((k) => (
          <button key={k} className={`chip ${k} ${status === k ? "on" : ""}`} onClick={() => setStatus(k)}>
            {k === "all" ? (
              <>All <b>{stores.length}</b></>
            ) : (
              <><span className="dot" /> {k === "nodata" ? "No data" : k[0].toUpperCase() + k.slice(1)} <b>{counts[k]}</b></>
            )}
          </button>
        ))}
      </div>

      <div className="ctrls">
        <div className="search">
          <span className="mag">⌕</span>
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search store or region…"
            aria-label="Search stores"
          />
          {q && <button className="clr" onClick={() => setQ("")} aria-label="clear">×</button>}
        </div>
        {showRegion && (
          <select value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Filter by region">
            <option value="all">All regions</option>
            {regions.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        )}
        <select value={retailer} onChange={(e) => setRetailer(e.target.value)} aria-label="Filter by retailer">
          <option value="all">All retailers</option>
          {retailers.map((r) => (
            <option key={r} value={r}>{retailerLabel(r)}</option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort by">
          {SORTS.filter((s) => s.k !== "stockouts" || anyStockouts).map((s) => (
            <option key={s.k} value={s.k}>Sort: {s.label}</option>
          ))}
        </select>
      </div>

      <div className="cntline">
        Showing <b>{rows.length}</b> of {stores.length} stores
        {filtered && (
          <button
            className="reset"
            onClick={() => { setQ(""); setStatus("all"); setRegion("all"); setRetailer("all"); }}
          >
            Clear filters
          </button>
        )}
        <button className="csvbtn" onClick={downloadCsv} disabled={rows.length === 0} title="Download the current view as CSV">
          ↧ Download CSV
        </button>
      </div>

      {rows.length ? (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Store</th>{showRegion && <th>Region</th>}<th>Retailer</th><th>Status</th>
                <th className="num">Waste %</th>{anyStockouts && <th className="num">Sold out</th>}<th className="num">Sold (wk)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.store_id} className="clk">
                  <td className="strong"><Link href={`/store/${s.store_id}`}>{s.name}</Link></td>
                  {showRegion && <td style={{ color: "var(--ink2)" }}>{s.region ?? "—"}</td>}
                  <td style={{ color: "var(--ink2)" }}>{retailerLabel(s.retailer)}</td>
                  <td><StatusTag status={effOf(s)} /></td>
                  <td className="num">{s.waste_pct == null ? "—" : `${s.waste_pct}%`}</td>
                  {anyStockouts && <td className="num">{num(s.stockout_days) || "—"}</td>}
                  {/* No-data stores have no feed yet — show "—", not a misleading 0 sold (matches the waste column). */}
                  <td className="num">{effOf(s) === "nodata" ? "—" : nf(num(s.total_sold))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="nomatch">
          No stores match <b>{q ? `“${q}”` : "these filters"}</b>. <button className="reset" onClick={() => { setQ(""); setStatus("all"); setRegion("all"); setRetailer("all"); }}>Clear filters</button>
        </div>
      )}

      <style>{`
        .slist .viewbanner{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--card);border:1px solid var(--crust);border-left:3px solid var(--crust);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:13px}
        .slist .viewbanner .vb-l{color:var(--muted);text-transform:uppercase;font-size:11px;font-weight:700;letter-spacing:.4px}
        .slist .viewbanner b{color:var(--ink);font-weight:600}
        .slist .viewbanner .vb-c{color:var(--ink2);font-variant-numeric:tabular-nums}
        .slist .viewbanner .vb-x{margin-left:auto;border:none;background:none;color:var(--crust-deep);font-weight:600;font-size:12.5px;cursor:pointer;font-family:inherit;text-decoration:underline}
        .slist .chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
        .slist .chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);background:var(--card);border-radius:999px;padding:7px 14px;font-size:13px;font-weight:600;color:var(--ink2);cursor:pointer;font-family:inherit}
        .slist .chip b{color:var(--ink);font-variant-numeric:tabular-nums}
        .slist .chip .dot{width:8px;height:8px;border-radius:50%}
        .slist .chip.red .dot{background:var(--red)} .slist .chip.amber .dot{background:var(--amber)} .slist .chip.green .dot{background:var(--green)}
        .slist .chip.nodata .dot{background:var(--muted)}
        .slist .chip.nodata.on{background:var(--muted);border-color:var(--muted);color:#fff}
        .slist .chip.on{border-color:var(--espresso);background:var(--espresso);color:#f7efdd}
        .slist .chip.on b{color:#fff}
        .slist .chip.red.on{background:var(--red);border-color:var(--red);color:#fff}
        .slist .chip.amber.on{background:var(--amber-t);border-color:var(--amber-t);color:#fff}
        .slist .chip.green.on{background:var(--green-t);border-color:var(--green-t);color:#fff}

        .slist .ctrls{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
        .slist .search{position:relative;flex:1;min-width:220px}
        .slist .search .mag{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:15px}
        .slist .search input{width:100%;border:1px solid var(--line);border-radius:10px;padding:10px 34px;font-size:14px;font-family:inherit;background:var(--surface);color:var(--ink);outline:none}
        .slist .search input:focus{border-color:var(--crust)}
        .slist .search .clr{position:absolute;right:8px;top:50%;transform:translateY(-50%);border:none;background:var(--line2);color:var(--ink2);width:20px;height:20px;border-radius:50%;cursor:pointer;font-size:13px;line-height:1}
        .slist select{border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:13.5px;font-family:inherit;background:var(--surface);color:var(--ink);outline:none;cursor:pointer;max-width:200px}

        .slist .cntline{font-size:12.5px;color:var(--muted);margin-bottom:10px;display:flex;align-items:center;gap:12px}
        .slist .cntline b{color:var(--ink)}
        .slist .csvbtn{margin-left:auto;border:1px solid var(--line);background:var(--card);color:var(--ink2);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
        .slist .csvbtn:hover{background:#f6f0e6;color:var(--ink)}
        .slist .csvbtn:disabled{opacity:.5;cursor:default}
        .slist .reset{border:none;background:none;color:var(--crust-deep);font-weight:600;font-size:12.5px;cursor:pointer;font-family:inherit;text-decoration:underline}
        .slist .nomatch{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:26px 20px;text-align:center;color:var(--ink2);font-size:14px}
      `}</style>
    </div>
  );
}
