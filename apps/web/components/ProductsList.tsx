"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { ProductPerf } from "@/lib/queries";
import { createProductLaunch } from "@/app/products/actions";

const CATEGORY_OPTS = ["sourdough", "bagel", "challah", "pita", "pastry", "cake", "other"];

/* ------------------------------------------------------------------ *
 * Products directory — the per-product lens on the whole network,
 * aggregated live from the engine ledger (store_reco). The Stores page
 * answers "which store needs me"; this answers "which line is wasting,
 * which is under-ordered, how widely is it ranged". Searchable by name,
 * filterable by category, sortable by what matters. All client-side over
 * the already-fetched rows — no extra queries.
 * ------------------------------------------------------------------ */

const nf = (n: number) => (Number(n) || 0).toLocaleString("en-AU");
const num = (v: unknown) => Number(v) || 0;
const titleCase = (t: string) => (t || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

type SortKey = "waste" | "sell" | "sent" | "change" | "stores" | "name";
const SORTS: { k: SortKey; label: string }[] = [
  { k: "waste", label: "Waste %" },
  { k: "sell", label: "Sell-through" },
  { k: "sent", label: "Delivered" },
  { k: "change", label: "Biggest engine cut" },
  { k: "stores", label: "Stores ranged" },
  { k: "name", label: "Name A–Z" },
];

// CSV-escape a cell (quote when it contains a comma, quote, or newline).
const csvCell = (v: string | number | null) => {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export default function ProductsList({ products }: { products: ProductPerf[] }) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("all");
  const [sort, setSort] = useState<SortKey>("waste");

  const categories = useMemo(
    () => [...new Set(products.map((p) => p.category).filter(Boolean))].sort(),
    [products],
  );

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = products.filter(
      (p) =>
        (category === "all" || p.category === category) &&
        (!term || p.name.toLowerCase().includes(term) || (p.category ?? "").toLowerCase().includes(term)),
    );
    return [...list].sort((a, b) => {
      switch (sort) {
        case "sell":
          return num(b.sell_through) - num(a.sell_through);
        case "sent":
          return num(b.sent) - num(a.sent);
        case "change":
          // Biggest engine cut first (most negative change = most over-delivered).
          return num(a.change) - num(b.change);
        case "stores":
          return num(b.stores) - num(a.stores);
        case "name":
          return a.name.localeCompare(b.name);
        default:
          return num(b.waste_pct) - num(a.waste_pct) || num(b.sent) - num(a.sent);
      }
    });
  }, [products, q, category, sort]);

  const filtered = q || category !== "all";

  // Network totals for the header strip — real, summed from the rows.
  const totals = useMemo(() => {
    const sent = products.reduce((a, p) => a + num(p.sent), 0);
    const sold = products.reduce((a, p) => a + num(p.sold), 0);
    return {
      lines: products.length,
      sent,
      sold,
      wastePct: sent > 0 ? Math.round((1000 * (sent - sold)) / sent) / 10 : null,
    };
  }, [products]);

  function downloadCsv() {
    const header = ["Product", "Category", "Stores ranged", "Delivered (wk)", "Sold (wk)", "Sell-through %", "Waste %", "Engine change"];
    const body = rows.map((p) =>
      [
        p.name,
        titleCase(p.category),
        num(p.stores),
        num(p.sent),
        num(p.sold),
        p.sell_through == null ? "" : p.sell_through,
        p.waste_pct == null ? "" : p.waste_pct,
        p.change,
      ].map(csvCell).join(","),
    );
    const csv = [header.map(csvCell).join(","), ...body].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jesses-bakery-products-${rows.length}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  if (!products.length) {
    return (
      <div className="plist">
        <div className="empty">
          The product ledger is warming up. This lists every line the engine plans across the network — delivered vs sold,
          sell-through and waste per product — and fills in as the engine plan (store_reco) loads.
        </div>
        <style>{`.plist .empty{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:26px 20px;text-align:center;color:var(--ink2);font-size:14px;line-height:1.6}`}</style>
      </div>
    );
  }

  return (
    <div className="plist">
      <div className="strip">
        <div className="tile"><div className="tn">{totals.lines}</div><div className="tl">Lines ranged · network</div></div>
        <div className="tile"><div className="tn">{nf(totals.sent)}</div><div className="tl">Delivered · units / wk</div></div>
        <div className="tile"><div className="tn">{nf(totals.sold)}</div><div className="tl">Sold · units / wk</div></div>
        <div className="tile"><div className="tn">{totals.wastePct ?? "—"}<span className="u">%</span></div><div className="tl">Implied waste · delivered − sold</div></div>
      </div>

      <NewProductLaunch />

      <div className="ctrls">
        <div className="search">
          <span className="mag">⌕</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search product…" aria-label="Search products" />
          {q && <button className="clr" onClick={() => setQ("")} aria-label="clear">×</button>}
        </div>
        <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Filter by category">
          <option value="all">All categories</option>
          {categories.map((c) => (
            <option key={c} value={c}>{titleCase(c)}</option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort by">
          {SORTS.map((s) => (
            <option key={s.k} value={s.k}>Sort: {s.label}</option>
          ))}
        </select>
      </div>

      <div className="cntline">
        Showing <b>{rows.length}</b> of {products.length} products
        {filtered && (
          <button className="reset" onClick={() => { setQ(""); setCategory("all"); }}>Clear filters</button>
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
                <th>Product</th><th>Category</th>
                <th className="num">Stores</th><th className="num">Delivered</th><th className="num">Sold</th>
                <th className="num">Sell-through</th><th className="num">Waste %</th><th className="num">Engine change</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const chg = num(p.change);
                return (
                  <tr key={p.product_id}>
                    <td className="strong">{p.name}</td>
                    <td style={{ color: "var(--ink2)" }}>{titleCase(p.category)}</td>
                    <td className="num">{nf(num(p.stores))}</td>
                    <td className="num">{nf(num(p.sent))}</td>
                    <td className="num">{nf(num(p.sold))}</td>
                    <td className="num">{p.sell_through == null ? "—" : `${p.sell_through}%`}</td>
                    <td className="num"><span className={`wp ${num(p.waste_pct) >= 25 ? "hi" : num(p.waste_pct) >= 12 ? "mid" : "lo"}`}>{p.waste_pct == null ? "—" : `${p.waste_pct}%`}</span></td>
                    <td className="num"><span className={`chg ${chg < 0 ? "cut" : chg > 0 ? "add" : "flat"}`}>{chg > 0 ? "+" : ""}{nf(chg)}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="nomatch">
          No products match <b>{q ? `“${q}”` : "these filters"}</b>. <button className="reset" onClick={() => { setQ(""); setCategory("all"); }}>Clear filters</button>
        </div>
      )}

      <div className="foot">
        Live from the engine plan (store_reco). Sell-through is sold ÷ delivered; waste is delivered − sold (inferred, the
        same method as the store view). Engine change is the net order move the engine recommends across the network —
        negative trims an over-delivered line, positive lifts an under-ordered one.
      </div>

      <style>{`
        .plist .strip{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}
        .plist .tile{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px}
        .plist .tn{font-family:var(--serif);font-size:30px;font-weight:600;line-height:1;letter-spacing:-.6px;font-variant-numeric:tabular-nums}
        .plist .tn .u{font-size:15px;color:var(--muted);font-family:var(--sans);font-weight:500}
        .plist .tl{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.4}

        .plist .ctrls{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
        .plist .search{position:relative;flex:1;min-width:220px}
        .plist .search .mag{position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:15px}
        .plist .search input{width:100%;border:1px solid var(--line);border-radius:10px;padding:10px 34px;font-size:14px;font-family:inherit;background:var(--surface);color:var(--ink);outline:none}
        .plist .search input:focus{border-color:var(--crust)}
        .plist .search .clr{position:absolute;right:8px;top:50%;transform:translateY(-50%);border:none;background:var(--line2);color:var(--ink2);width:20px;height:20px;border-radius:50%;cursor:pointer;font-size:13px;line-height:1}
        .plist select{border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:13.5px;font-family:inherit;background:var(--surface);color:var(--ink);outline:none;cursor:pointer;max-width:220px}

        .plist .cntline{font-size:12.5px;color:var(--muted);margin-bottom:10px;display:flex;align-items:center;gap:12px}
        .plist .cntline b{color:var(--ink)}
        .plist .csvbtn{margin-left:auto;border:1px solid var(--line);background:var(--card);color:var(--ink2);border-radius:8px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}
        .plist .csvbtn:hover{background:#f6f0e6;color:var(--ink)}
        .plist .csvbtn:disabled{opacity:.5;cursor:default}
        .plist .reset{border:none;background:none;color:var(--crust-deep);font-weight:600;font-size:12.5px;cursor:pointer;font-family:inherit;text-decoration:underline}

        .plist td.strong a{color:inherit;text-decoration:none} .plist td.strong a:hover{color:var(--crust-deep);text-decoration:underline}
        .plist .wp{font-weight:600;font-variant-numeric:tabular-nums}
        .plist .wp.hi{color:var(--red-t)} .plist .wp.mid{color:var(--amber-t)} .plist .wp.lo{color:var(--ink2)}
        .plist .chg{font-weight:700;font-variant-numeric:tabular-nums}
        .plist .chg.cut{color:var(--red-t)} .plist .chg.add{color:var(--green-t)} .plist .chg.flat{color:var(--muted)}

        .plist .nomatch{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:26px 20px;text-align:center;color:var(--ink2);font-size:14px}
        .plist .foot{margin-top:14px;font-size:12px;color:var(--muted);line-height:1.6}

        @media (max-width:1080px){ .plist .strip{grid-template-columns:1fr 1fr} }
      `}</style>
    </div>
  );
}

function NewProductLaunch() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("pastry");
  const [date, setDate] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function submit() {
    setMsg(null);
    const nm = name.trim();
    start(async () => {
      const res = await createProductLaunch({ name: nm, category, launchedAt: date || undefined });
      if (res.ok) {
        setMsg({ ok: true, text: `"${nm}" added — now tracking in Launches under New products.` });
        setName(""); setDate("");
        router.refresh();
      } else {
        setMsg({ ok: false, text: res.error });
      }
    });
  }

  return (
    <div className="npl">
      {!open ? (
        <button className="npl-open" onClick={() => { setOpen(true); setMsg(null); }}>+ New product launch</button>
      ) : (
        <div className="npl-form">
          <div className="npl-h">Track a new product line from day one</div>
          <div className="npl-row">
            <input className="npl-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Product name (e.g. Choc Babka)" aria-label="Product name" />
            <select value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
              {CATEGORY_OPTS.map((c) => <option key={c} value={c}>{titleCase(c)}</option>)}
            </select>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Launch date (defaults to today)" />
            <button className="npl-add" onClick={submit} disabled={pending || !name.trim()}>{pending ? "Adding…" : "Add launch"}</button>
            <button className="npl-cancel" onClick={() => { setOpen(false); setMsg(null); }} disabled={pending}>Cancel</button>
          </div>
          <div className="npl-note">Adds the line and tags today (or the date above) as its launch. It appears in Launches immediately and fills with units and sell-through as the plan and sales come in.</div>
        </div>
      )}
      {msg && <div className={`npl-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}{msg.ok && <> <a href="/launches">Open Launches →</a></>}</div>}
      <style>{`
        .plist .npl{margin-bottom:14px}
        .plist .npl-open{border:1px dashed var(--line);background:var(--surface);color:var(--crust-deep);border-radius:10px;padding:10px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
        .plist .npl-open:hover{background:#f6f0e6}
        .plist .npl-form{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:14px 16px}
        .plist .npl-h{font-family:var(--serif);font-size:15px;font-weight:600;margin-bottom:10px}
        .plist .npl-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
        .plist .npl-name{flex:1;min-width:200px;border:1px solid var(--line);border-radius:9px;padding:9px 11px;font-size:14px;font-family:inherit;background:var(--surface);color:var(--ink);outline:none}
        .plist .npl-name:focus{border-color:var(--crust)}
        .plist .npl-add{border:none;background:var(--espresso);color:#f7efdd;border-radius:9px;padding:9px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
        .plist .npl-add:disabled{opacity:.5;cursor:default}
        .plist .npl-cancel{border:1px solid var(--line);background:var(--card);color:var(--muted);border-radius:9px;padding:9px 12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
        .plist .npl-note{font-size:11.5px;color:var(--muted);line-height:1.5;margin-top:9px}
        .plist .npl-msg{margin-top:10px;font-size:12.5px;font-weight:600;border-radius:9px;padding:9px 12px}
        .plist .npl-msg.ok{background:var(--green-b);color:var(--green-t);border:1px solid var(--green)}
        .plist .npl-msg.err{background:var(--red-b,#f7e4e0);color:var(--red-t,#a4372a);border:1px solid var(--red,#c0563f)}
        .plist .npl-msg a{color:inherit;text-decoration:underline}
      `}</style>
    </div>
  );
}
