"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import StatusTag from "@/components/StatusTag";
import RetailerBadge from "@/components/RetailerBadge";
import type { StoreWeek, Status } from "@/lib/queries";
import { isCapStale, effectiveCap, type ShelfCapOverride } from "@/lib/shelfcap";

/* ------------------------------------------------------------------ *
 * Stores directory — the searchable, filterable list of every active
 * store. Live from v_store_week. An unfiltered 265-row table is hard to
 * work; this lets Simona jump to a store by name, or narrow to a region,
 * a retailer, or just the red ones, and sort by what matters. All
 * client-side over the already-fetched rows — no extra queries.
 * ------------------------------------------------------------------ */

const nf = (n: number) => (Number(n) || 0).toLocaleString("en-AU");
const num = (v: unknown) => Number(v) || 0;

// Two ways a store has no assessable data, and both must read "No data" rather
// than green or red:
//   1. nothing delivered and nothing sold — no feed loaded yet.
//   2. no sales feed at all — an invoice customer. Jesse delivers and invoices
//      them; they never report a scan sale. Their waste isn't 0% or 100%, it's
//      unknowable. Without this they'd show as delivered-everything-sold-nothing,
//      i.e. 100% waste, flagged red (migration 027).
const hasData = (s: StoreWeek) =>
  s.has_sales_feed !== false && (Number(s.total_sent) > 0 || Number(s.total_sold) > 0);
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
const VIEWS: Record<string, { label: string; test: (s: StoreWeek, ov?: ShelfCapOverride, peak?: number) => boolean }> = {
  waste30: { label: "Excessive waste (>30%)", test: (s) => s.waste_pct != null && num(s.waste_pct) > 30 },
  // Same gate as the Overview action list, so the count on the tile and the
  // length of this list are always the same number: a store that sells out on a
  // line but still wastes 20%+ of its delivery has a range/cadence problem, not
  // a volume one, and doesn't belong under "increase allocation".
  stockouts: { label: "Selling out without over-supplying", test: (s) => num(s.stockout_days) > 0 && (s.waste_pct == null || num(s.waste_pct) < 20) },
  overdeliver: { label: "Allocation opportunities · over-delivering", test: (s) => num(s.total_sent) - num(s.total_sold) > Math.max(20, num(s.total_sold) * 0.2) },
  expandrange: { label: "Could expand range", test: (s) => { const st = sellThroughOf(s); const w = s.waste_pct == null ? null : num(s.waste_pct); return st != null && st >= 95 && (w == null || w < 12); } },
  outperform: { label: "Outperforming comparable stores", test: (s) => { const st = sellThroughOf(s); return s.status === "green" && st != null && st >= 92; } },
  declines: { label: "Abnormal sales declines", test: (s) => { const g = growthOf(s); return g != null && g < -10; } },
  // The only view here that isn't about performance. These stores are fine —
  // the number we hold FOR them is wrong, and it's shaping their plan. Judged
  // against the busiest single day, never the week: see lib/shelfcap.ts.
  capstale: { label: "Shelf cap smaller than a single day's sales", test: (s, ov, peak) => isCapStale(s, ov, peak) },
};

// CSV-escape a cell (quote when it contains a comma, quote, or newline).
const csvCell = (v: string | number | null) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default function StoresList({ stores, showRegion = true, initialView, states = {}, capOverrides = {}, peakDay = {} }: { stores: StoreWeek[]; showRegion?: boolean; initialView?: string; states?: Record<string, string>; capOverrides?: Record<string, ShelfCapOverride>; peakDay?: Record<string, number> }) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | Eff>("all");
  const [region, setRegion] = useState("all");
  const [retailer, setRetailer] = useState("all");
  const [stateF, setStateF] = useState("all");
  // Distinct states present (NSW/ACT today; QLD appears once Somnath's stores load).
  const stateOpts = useMemo(
    () => [...new Set(Object.values(states))].sort(),
    [states],
  );
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
        (!activeView || activeView.test(s, capOverrides[s.store_id], peakDay[s.store_id])) &&
        (status === "all" || effOf(s) === status) &&
        (region === "all" || s.region === region) &&
        (retailer === "all" || s.retailer === retailer) &&
        (stateF === "all" || states[s.store_id] === stateF) &&
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
  }, [stores, q, status, region, retailer, stateF, states, sort, activeView, capOverrides, peakDay]);

  const filtered = q || status !== "all" || region !== "all" || retailer !== "all" || stateF !== "all";

  // Export exactly what's on screen (current filter + sort) as CSV — Simona
  // works from spreadsheets, so the filtered view goes straight to one.
  function downloadCsv() {
    const header = ["Store", ...(showRegion ? ["Delivery run"] : []), "Retailer", "Status", "Waste %", "Sold-out days", "Sold (wk)"];
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
        <div className={`viewbanner${view === "capstale" ? " cap" : ""}`}>
          <span className="vb-l">Showing</span>
          <b>{activeView.label}</b>
          <span className="vb-c">{rows.length} store{rows.length === 1 ? "" : "s"}</span>
          <button className="vb-x" onClick={() => setView("")}>Show all stores ×</button>
        </div>
      )}
      {view === "capstale" && (
        <>
          {/* The list on its own would send her store by store with no idea what
              she's looking for. Each row carries the two numbers that make the
              case: the cap we hold, and the most that store sold in ONE day. */}
          <div className="capnote">
            A shelf cap is how many units the fixture holds <b>at once</b>, not
            over a week — a 90-unit bay refilled six mornings a week sells far
            more than 90. These stores sold more in a <b>single day</b> than their
            cap allows, so the shelf held more than the cap says it can and the
            figure on file is wrong. <b>Nothing is being blocked by these caps</b>;
            open a store and type the real shelf size in to clear it.
          </div>
          <ul className="caplist">
            {rows.map((s) => {
              const cap = effectiveCap(s, capOverrides[s.store_id]);
              const peak = num(peakDay[s.store_id]);
              return (
                <li key={s.store_id}>
                  <Link prefetch={false} href={`/store/${s.store_id}`}>{s.name}</Link>
                  <span className="cl-r">
                    <span className="cl-cap">cap on file <b>{nf(cap ?? 0)}</b></span>
                    <span className="cl-sold">busiest day <b>{nf(peak)}</b></span>
                    <span className="cl-sold">week <b>{nf(num(s.total_sold))}</b></span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
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
            placeholder="Search store or delivery run…"
            aria-label="Search stores"
          />
          {q && <button className="clr" onClick={() => setQ("")} aria-label="clear">×</button>}
        </div>
        {stateOpts.length > 1 && (
          <select value={stateF} onChange={(e) => setStateF(e.target.value)} aria-label="Filter by state">
            <option value="all">All states</option>
            {stateOpts.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        )}
        {showRegion && (
          <select value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Filter by delivery run">
            <option value="all">All delivery runs</option>
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
            onClick={() => { setQ(""); setStatus("all"); setRegion("all"); setRetailer("all"); setStateF("all"); }}
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
                <th>Store</th>{showRegion && <th>Delivery run</th>}<th>Retailer</th><th>Status</th>
                <th className="num">Waste %</th>{anyStockouts && <th className="num">Sold out</th>}<th className="num">Sent (wk)</th><th className="num">Sold (wk)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.store_id} className="clk" onClick={() => router.push(`/store/${s.store_id}`)}>
                  <td className="strong"><Link prefetch={false} href={`/store/${s.store_id}`} onClick={(e) => e.stopPropagation()}>{s.name}</Link></td>
                  {showRegion && <td style={{ color: "var(--ink2)" }}>{s.region ?? "—"}</td>}
                  <td><RetailerBadge retailer={s.retailer} size="sm" /></td>
                  <td><StatusTag status={effOf(s)} /></td>
                  <td className="num">{s.waste_pct == null ? "—" : `${s.waste_pct}%`}</td>
                  {anyStockouts && <td className="num">{num(s.stockout_days) || "—"}</td>}
                  {/* No delivered figure yet (no-data store, or sold-only feed with no
                      delivered/sent data loaded) — show "—", not a misleading 0. A 0 next
                      to real sold units reads as "sold X from nothing delivered". Matches
                      the waste column, which is also "—" until delivered data lands. */}
                  <td className="num">{effOf(s) === "nodata" || num(s.total_sent) === 0 ? "—" : nf(num(s.total_sent))}</td>
                  <td className="num">{effOf(s) === "nodata" ? "—" : nf(num(s.total_sold))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="nomatch">
          No stores match <b>{q ? `“${q}”` : "these filters"}</b>. <button className="reset" onClick={() => { setQ(""); setStatus("all"); setRegion("all"); setRetailer("all"); setStateF("all"); }}>Clear filters</button>
        </div>
      )}

      <style>{`
        .slist .viewbanner{display:flex;align-items:center;gap:10px;flex-wrap:wrap;background:var(--card);border:1px solid var(--crust);border-left:3px solid var(--crust);border-radius:10px;padding:10px 14px;margin-bottom:14px;font-size:13px}
        .slist .viewbanner .vb-l{color:var(--muted);text-transform:uppercase;font-size:11px;font-weight:700;letter-spacing:.4px}
        .slist .viewbanner b{color:var(--ink);font-weight:600}
        .slist .viewbanner .vb-c{color:var(--ink2);font-variant-numeric:tabular-nums}
        .slist .viewbanner .vb-x{margin-left:auto;border:none;background:none;color:var(--crust-deep);font-weight:600;font-size:12.5px;cursor:pointer;font-family:inherit;text-decoration:underline}

        /* Violet across the app means one thing: reference data we can prove is
           wrong. Same colour on the store-page banner, the Overview action row
           and here, so the three read as one alert rather than three notices. */
        .slist .viewbanner.cap{border-color:#b6a3d4;border-left-color:#7b5ea7;background:#f6f3fb}
        .slist .capnote{background:#f6f3fb;border:1px solid #ded2ee;border-radius:10px;padding:11px 15px;font-size:13px;line-height:1.55;color:#4a3a63;margin-bottom:12px}
        .slist .capnote b{color:#3b2d50}
        .slist .caplist{list-style:none;margin:0 0 18px;padding:0;display:flex;flex-direction:column;gap:5px}
        .slist .caplist li{display:flex;align-items:baseline;gap:12px;padding:7px 12px;border:1px solid var(--line2);border-left:3px solid #7b5ea7;border-radius:8px;background:var(--card);font-size:13px}
        .slist .caplist li a{font-weight:600;color:var(--ink);text-decoration:none}
        .slist .caplist li a:hover{text-decoration:underline}
        .slist .caplist .cl-r{margin-left:auto;display:flex;gap:16px;font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
        .slist .caplist .cl-r b{color:var(--ink2);font-weight:700}
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
        /* Whole row opens the store — the name stays a real link (right-click / new tab), the rest of the row navigates on click. */
        .slist tbody tr.clk{cursor:pointer}
        .slist tbody tr.clk:hover{background:var(--surface)}
      `}</style>
    </div>
  );
}
