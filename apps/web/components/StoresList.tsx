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
const ORDER: Record<Status, number> = { red: 0, amber: 1, green: 2 };
type SortKey = "status" | "waste" | "sold" | "stockouts" | "name";
const SORTS: { k: SortKey; label: string }[] = [
  { k: "status", label: "Worst first" },
  { k: "waste", label: "Waste %" },
  { k: "stockouts", label: "Stockouts" },
  { k: "sold", label: "Units sold" },
  { k: "name", label: "Name A–Z" },
];

const retailerLabel = (r: string) =>
  r === "harris_farm" ? "Harris Farm" : r ? r[0].toUpperCase() + r.slice(1) : "—";

export default function StoresList({ stores, showRegion = true }: { stores: StoreWeek[]; showRegion?: boolean }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"all" | Status>("all");
  const [region, setRegion] = useState("all");
  const [retailer, setRetailer] = useState("all");
  const [sort, setSort] = useState<SortKey>("status");

  const regions = useMemo(
    () => [...new Set(stores.map((s) => s.region).filter(Boolean) as string[])].sort(),
    [stores],
  );
  const retailers = useMemo(
    () => [...new Set(stores.map((s) => s.retailer).filter(Boolean))].sort(),
    [stores],
  );
  const counts = useMemo(() => {
    const c: Record<Status, number> = { red: 0, amber: 0, green: 0 };
    for (const s of stores) c[s.status] = (c[s.status] ?? 0) + 1;
    return c;
  }, [stores]);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = stores.filter(
      (s) =>
        (status === "all" || s.status === status) &&
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
          return ORDER[a.status] - ORDER[b.status] || num(b.total_wasted) - num(a.total_wasted);
      }
    });
  }, [stores, q, status, region, retailer, sort]);

  const filtered = q || status !== "all" || region !== "all" || retailer !== "all";

  return (
    <div className="slist">
      <div className="chips">
        {(["all", "red", "amber", "green"] as const).map((k) => (
          <button key={k} className={`chip ${k} ${status === k ? "on" : ""}`} onClick={() => setStatus(k)}>
            {k === "all" ? (
              <>All <b>{stores.length}</b></>
            ) : (
              <><span className="dot" /> {k[0].toUpperCase() + k.slice(1)} <b>{counts[k]}</b></>
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
          {SORTS.map((s) => (
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
      </div>

      {rows.length ? (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Store</th>{showRegion && <th>Region</th>}<th>Retailer</th><th>Status</th>
                <th className="num">Waste %</th><th className="num">Stockouts</th><th className="num">Sold (wk)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.store_id} className="clk">
                  <td className="strong"><Link href={`/store/${s.store_id}`}>{s.name}</Link></td>
                  {showRegion && <td style={{ color: "var(--ink2)" }}>{s.region ?? "—"}</td>}
                  <td style={{ color: "var(--ink2)" }}>{retailerLabel(s.retailer)}</td>
                  <td><StatusTag status={s.status} /></td>
                  <td className="num">{s.waste_pct == null ? "—" : `${s.waste_pct}%`}</td>
                  <td className="num">{num(s.stockout_days) || "—"}</td>
                  <td className="num">{nf(num(s.total_sold))}</td>
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
        .slist .chips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}
        .slist .chip{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--line);background:var(--card);border-radius:999px;padding:7px 14px;font-size:13px;font-weight:600;color:var(--ink2);cursor:pointer;font-family:inherit}
        .slist .chip b{color:var(--ink);font-variant-numeric:tabular-nums}
        .slist .chip .dot{width:8px;height:8px;border-radius:50%}
        .slist .chip.red .dot{background:var(--red)} .slist .chip.amber .dot{background:var(--amber)} .slist .chip.green .dot{background:var(--green)}
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
        .slist .reset{border:none;background:none;color:var(--crust-deep);font-weight:600;font-size:12.5px;cursor:pointer;font-family:inherit;text-decoration:underline}
        .slist .nomatch{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:26px 20px;text-align:center;color:var(--ink2);font-size:14px}
      `}</style>
    </div>
  );
}
