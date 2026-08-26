import Link from "next/link";
import type { ProductDetail, ProductStore } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Product profile — the drill-down from the Products table. Answers the
 * question the list can't: for this one line, WHICH stores range it and
 * which are wasting it. All from the plan (store_reco), same lines
 * and method as the Products page. Worst-waste-first.
 * ------------------------------------------------------------------ */

const nf = (n: number) => (Number(n) || 0).toLocaleString("en-AU");
const titleCase = (t: string) => (t || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const wasteClass = (w: number | null) => (w == null ? "" : w >= 25 ? "hi" : w >= 12 ? "mid" : "lo");
// A cut trims over-delivery (reduces waste) -> good; a lift raises an
// under-ordered line -> neutral/informational. Never alarm-red.
const chgClass = (c: number) => (c < 0 ? "cut" : c > 0 ? "add" : "flat");

export default function ProductProfile({ product, stores }: { product: ProductDetail; stores: ProductStore[] }) {
  const p = product;
  const ranked = [...stores].sort((a, b) => (b.waste_pct ?? -1) - (a.waste_pct ?? -1));

  return (
    <div className="pprof">
      <div className="phead">
        <div>
          <h1>{p.name}</h1>
          <div className="psub">
            {titleCase(p.category)} · ranged in {p.stores} {p.stores === 1 ? "store" : "stores"}
            {p.launched ? <span className="plaunch">● Launching</span> : null}
          </div>
        </div>
      </div>

      <div className="strip">
        <div className="tile"><div className="tn">{nf(p.sent)}</div><div className="tl">Delivered · units / wk, every store</div></div>
        <div className="tile"><div className="tn">{nf(p.sold)}</div><div className="tl">Sold · units / wk, stores that report</div></div>
        <div className="tile"><div className="tn">{p.sell_through == null ? "—" : `${p.sell_through}%`}</div><div className="tl">Sell-through{p.feed_sent > 0 ? ` · of ${nf(p.feed_sent)} units` : ""}</div></div>
        <div className="tile"><div className={`tn wp ${wasteClass(p.waste_pct)}`}>{p.waste_pct == null ? "—" : `${p.waste_pct}%`}</div><div className="tl">Waste · across the {p.feed_stores} {p.feed_stores === 1 ? "store" : "stores"} we can see</div></div>
        <div className="tile"><div className={`tn chg ${chgClass(p.change)}`}>{p.change > 0 ? "+" : ""}{nf(p.change)}</div><div className="tl">Difference · units / wk</div></div>
      </div>

      <div className="section-h"><span className="tick" />By store — worst waste first</div>
      {ranked.length ? (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Store</th><th>Delivery run</th>
                <th className="num">Delivered</th><th className="num">Sold</th>
                <th className="num">Sell-through</th><th className="num">Waste %</th><th className="num">Difference</th>
              </tr>
            </thead>
            <tbody>
              {ranked.map((s) => (
                <tr key={s.store_id}>
                  <td className="strong"><Link prefetch={false} href={`/store/${s.store_id}`}>{s.name}</Link></td>
                  <td style={{ color: "var(--ink2)" }}>{s.region ?? "—"}</td>
                  <td className="num">{nf(s.sent)}</td>
                  <td className="num">{s.has_sales_feed ? nf(s.sold) : <span className="nofeed" title="This store doesn't send us its sales, so there is no sold figure — the zero would be an absence of data, not an absence of sales.">no feed</span>}</td>
                  <td className="num">{s.sell_through == null ? "—" : `${s.sell_through}%`}</td>
                  <td className="num"><span className={`wp ${wasteClass(s.waste_pct)}`}>{s.waste_pct == null ? "—" : `${s.waste_pct}%`}</span></td>
                  <td className="num"><span className={`chg ${chgClass(s.change)}`}>{s.change > 0 ? "+" : ""}{nf(s.change)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">No store-level plan for this line yet. It fills in as the plan builds across stores.</div>
      )}

      <div className="foot">
        Live from the plan (store_reco) — the same core lines and method as the Products page. Delivered counts
        every store. Sell-through and waste only count the stores that send us their sales, so a store marked
        <b> no feed</b> is left out of both rather than counted as a total loss. Difference is the order move the plan
        recommends for this line at each store — a cut trims an over-delivered store, a lift raises an under-ordered
        one. Store names open the full store profile.
      </div>

      <style>{`
        .pprof .phead{margin-bottom:16px}
        .pprof .phead h1{font-family:var(--serif);font-size:26px;font-weight:600;letter-spacing:-.4px;margin:0}
        .pprof .psub{font-size:13.5px;color:var(--muted);margin-top:5px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
        .pprof .plaunch{font-size:11px;font-weight:700;color:var(--green-t);background:var(--green-b);border-radius:999px;padding:3px 9px}
        .pprof .strip{display:grid;grid-template-columns:repeat(5,1fr);gap:14px;margin-bottom:22px}
        .pprof .tile{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px}
        .pprof .tn{font-family:var(--serif);font-size:28px;font-weight:600;line-height:1;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
        .pprof .tl{font-size:11.5px;color:var(--muted);margin-top:8px;line-height:1.4}
        .pprof .wp.hi{color:var(--red-t)} .pprof .wp.mid{color:var(--amber-t)} .pprof .wp.lo{color:var(--ink2)}
        .pprof .nofeed{font-size:11.5px;color:var(--muted);cursor:help}
        .pprof .chg{font-variant-numeric:tabular-nums;font-weight:600}
        .pprof .chg.cut{color:var(--green-t)} .pprof .chg.add{color:var(--ink2)} .pprof .chg.flat{color:var(--muted)}
        .pprof td.strong a{color:inherit;text-decoration:none} .pprof td.strong a:hover{color:var(--crust-deep);text-decoration:underline}
        .pprof .empty{background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:24px 20px;text-align:center;color:var(--ink2);font-size:14px}
        .pprof .foot{margin-top:14px;font-size:12px;color:var(--muted);line-height:1.6}
        @media (max-width:1080px){ .pprof .strip{grid-template-columns:1fr 1fr} }
      `}</style>
    </div>
  );
}
