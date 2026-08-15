"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { StoreWeek } from "@/lib/queries";

const RTL: Record<string, string> = {
  woolworths: "Woolies", coles: "Coles", harris_farm: "Harris", harris: "Harris",
  iga: "IGA", invoice: "Direct", direct: "Direct", independent: "Indie",
};
const rtlLabel = (r: string) =>
  RTL[(r || "").toLowerCase()] ?? (r ? r.charAt(0).toUpperCase() + r.slice(1) : "—");
const areaOf = (region: string | null) =>
  region && ["Canberra", "Newcastle", "Central Coast"].includes(region) ? region : "Sydney";
const STAT: Record<string, [string, string]> = {
  red: ["red", "Needs attention"], amber: ["amber", "Watch"], green: ["green", "On track"],
};
const AREAS = ["all", "Sydney", "Canberra", "Central Coast", "Newcastle"];
const wasteColor = (s: string) => (s === "red" ? "var(--red)" : s === "amber" ? "var(--amber)" : "var(--green)");

export default function StoresBoard({ stores }: { stores: StoreWeek[] }) {
  const router = useRouter();
  const [term, setTerm] = useState("");
  const [region, setRegion] = useState("all");
  const [status, setStatus] = useState("all");
  const [area, setArea] = useState("all");
  const [sortKey, setSortKey] = useState<"waste" | "sold">("waste");
  const [sortDir, setSortDir] = useState(-1);

  const regions = useMemo(
    () => [...new Set(stores.map((s) => s.region).filter(Boolean) as string[])].sort(),
    [stores],
  );

  const t = term.trim().toLowerCase();
  const list = stores
    .filter((s) =>
      (area === "all" || areaOf(s.region) === area) &&
      (region === "all" || s.region === region) &&
      (status === "all" || s.status === status) &&
      (!t || s.name.toLowerCase().includes(t)),
    )
    .sort((a, b) => {
      const av = Number((sortKey === "waste" ? a.waste_pct : a.total_sold) ?? -1);
      const bv = Number((sortKey === "waste" ? b.waste_pct : b.total_sold) ?? -1);
      return (av - bv) * sortDir;
    });

  function toggleSort(k: "waste" | "sold") {
    if (sortKey === k) setSortDir((d) => -d);
    else { setSortKey(k); setSortDir(-1); }
  }
  const arrow = (k: "waste" | "sold") => (sortKey === k ? (sortDir < 0 ? "▾" : "▴") : "");

  return (
    <div className="storesb">
      <div className="toolbar">
        <label className="search">
          <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4-4" /></svg>
          <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search stores by name…" autoComplete="off" />
        </label>
        <div className="sel">
          <select value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Filter by region">
            <option value="all">All regions</option>
            {regions.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="sel">
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
            <option value="all">All statuses</option>
            <option value="red">Needs attention</option>
            <option value="amber">Watch</option>
            <option value="green">On track</option>
          </select>
        </div>
      </div>

      <div className="areachips">
        {AREAS.map((a) => (
          <button key={a} type="button" className={`achip ${area === a ? "on" : ""}`} onClick={() => setArea(a)}>
            {a === "all" ? "All areas" : a}
          </button>
        ))}
      </div>

      <div className="countline">Showing <b>{list.length}</b> of {stores.length} in view</div>

      <div className="tablewrap"><div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Store</th>
              <th>Region</th>
              <th>Status</th>
              <th className={`num sortable ${sortKey === "waste" ? "sorted" : ""}`} onClick={() => toggleSort("waste")}>Waste %<span className="ar">{arrow("waste")}</span></th>
              <th className="num">Stockouts</th>
              <th className={`num sortable ${sortKey === "sold" ? "sorted" : ""}`} onClick={() => toggleSort("sold")}>Sold (wk)<span className="ar">{arrow("sold")}</span></th>
            </tr>
          </thead>
          <tbody>
            {list.length === 0 ? (
              <tr><td colSpan={6}><div className="empty"><b>No stores match.</b><br />Try clearing a filter.</div></td></tr>
            ) : list.map((s) => {
              const [cls, label] = STAT[s.status] ?? ["green", "On track"];
              // DB returns numeric columns as strings — coerce before formatting.
              const w = s.waste_pct == null ? null : Number(s.waste_pct);
              const so = Number(s.stockout_days) || 0;
              const sold = Number(s.total_sold) || 0;
              return (
                <tr key={s.store_id} onClick={() => router.push(`/store/${s.store_id}`)}>
                  <td><span className="st-name"><span className="chev">→</span>{s.name}<span className="rtl">{rtlLabel(s.retailer)}</span></span></td>
                  <td className="region">{s.region ?? "—"}</td>
                  <td><span className={`tag ${cls}`}>● {label}</span></td>
                  <td className="num">
                    {w == null ? (
                      <span className="await">Awaiting feed</span>
                    ) : (
                      <div className="wcell">
                        <div className="wbar"><i style={{ width: `${Math.min(100, (w / 65) * 100)}%`, background: wasteColor(s.status) }} /></div>
                        <span className="wnum">{w.toFixed(1)}%</span>
                      </div>
                    )}
                  </td>
                  <td className="num">{so ? so : <span className="dash">—</span>}</td>
                  <td className="num">{sold.toLocaleString("en-AU")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div></div>

      <div className="foot">Click any store to open its detail — per-product orders, daily sell-through and the engine&apos;s recommendation. Waste is inferred from the on-hand ledger. Coles &amp; Harris Farm rows show <i>Awaiting feed</i> until their sales data lands.</div>

      <style>{`
      .storesb .toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
      .storesb .search{flex:1;min-width:220px;display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:11px;padding:0 12px;box-shadow:var(--sh);transition:.15s}
      .storesb .search:focus-within{border-color:var(--crust);box-shadow:0 0 0 3px rgba(176,116,28,.13)}
      .storesb .search svg{width:17px;height:17px;stroke:var(--muted);stroke-width:1.9;fill:none;flex:none}
      .storesb .search input{flex:1;border:none;background:transparent;padding:12px 2px;font-size:14px;font-family:inherit;outline:none;color:var(--ink)}
      .storesb .search input::placeholder{color:var(--faint)}
      .storesb .sel{position:relative}
      .storesb .sel select{appearance:none;-webkit-appearance:none;background:var(--card);border:1px solid var(--line);border-radius:11px;padding:11px 34px 11px 14px;font-size:13.5px;font-family:inherit;font-weight:500;color:var(--ink);cursor:pointer;box-shadow:var(--sh);outline:none}
      .storesb .sel select:focus{border-color:var(--crust);box-shadow:0 0 0 3px rgba(176,116,28,.13)}
      .storesb .sel::after{content:"▾";position:absolute;right:13px;top:50%;transform:translateY(-50%);color:var(--muted);pointer-events:none;font-size:12px}
      .storesb .areachips{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
      .storesb .achip{background:var(--card);border:1px solid var(--line);border-radius:999px;padding:7px 15px;font-size:12.5px;font-weight:600;cursor:pointer;color:var(--ink2);transition:.15s;font-family:inherit}
      .storesb .achip:hover{background:#f3ecdd}
      .storesb .achip.on{background:var(--espresso);border-color:var(--espresso);color:#f4ecdc}
      .storesb .countline{font-size:12.5px;color:var(--muted);margin-bottom:12px}
      .storesb .countline b{color:var(--ink2);font-weight:600}
      .storesb .scroll{overflow-x:auto}
      .storesb table{width:100%;border-collapse:collapse;min-width:720px}
      .storesb th{text-align:left;font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);padding:13px 18px;border-bottom:1px solid var(--line);font-weight:700;white-space:nowrap;background:var(--surface)}
      .storesb th.num{text-align:right}
      .storesb th.sortable{cursor:pointer;user-select:none}
      .storesb th.sortable:hover{color:var(--ink2)}
      .storesb th .ar{opacity:.5;margin-left:4px}
      .storesb th.sorted .ar{opacity:1;color:var(--crust-deep)}
      .storesb td{padding:13px 18px;border-bottom:1px solid var(--line2);font-size:14px;white-space:nowrap}
      .storesb tr:last-child td{border-bottom:none}
      .storesb tbody tr{cursor:pointer;transition:background .12s}
      .storesb tbody tr:hover{background:#faf6ee}
      .storesb .num{font-variant-numeric:tabular-nums;text-align:right}
      .storesb .st-name{font-weight:600;letter-spacing:-.1px;display:flex;align-items:center;gap:9px}
      .storesb .st-name .chev{opacity:0;transition:.15s;color:var(--crust);font-weight:700;transform:translateX(-3px)}
      .storesb tbody tr:hover .st-name .chev{opacity:1;transform:translateX(0)}
      .storesb .rtl{font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--faint);border:1px solid var(--line);border-radius:5px;padding:1px 5px;flex:none}
      .storesb .region{color:var(--ink2)}
      .storesb .wcell{display:flex;align-items:center;gap:10px;justify-content:flex-end}
      .storesb .wbar{width:52px;height:6px;background:#f0e9db;border-radius:4px;overflow:hidden;flex:none}
      .storesb .wbar i{display:block;height:100%;border-radius:4px}
      .storesb .wnum{font-variant-numeric:tabular-nums;font-weight:600;width:46px;text-align:right}
      .storesb .await{color:var(--faint);font-style:italic;font-size:12.5px}
      .storesb .dash{color:var(--faint)}
      .storesb .empty{padding:40px 18px;text-align:center;color:var(--muted)}
      .storesb .empty b{color:var(--ink2)}
      .storesb .foot{margin-top:26px;font-size:11.5px;color:var(--faint);border-top:1px solid var(--line);padding-top:16px;line-height:1.6}
      @media(max-width:720px){.storesb .search{min-width:100%;flex-basis:100%}}
      `}</style>
    </div>
  );
}
