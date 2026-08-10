import Link from "next/link";
import { notFound } from "next/navigation";
import { getStoreById, getStoreDaily, getStoreProducts, getStoreRecos } from "@/lib/queries";
import StatusTag from "@/components/StatusTag";
import StoreBars from "@/components/StoreBars";

export const revalidate = 120; // cache pages ~2 min so navigation is instant (prefetchable)

export default async function StorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [store, daily, products, recos] = await Promise.all([
    getStoreById(id), getStoreDaily(id), getStoreProducts(id), getStoreRecos(id),
  ]);
  if (!store) notFound();

  // Store-level roll-up of the engine's call: how much less to send this week.
  const sentNow = recos.reduce((a, r) => a + r.sent, 0);
  const engineSend = recos.reduce((a, r) => a + r.recommended, 0);
  const trimTotal = sentNow - engineSend;

  const soldDelta =
    store.total_sold_prev > 0
      ? Math.round((1000 * (store.total_sold - store.total_sold_prev)) / store.total_sold_prev) / 10
      : 0;

  return (
    <>
      <div className="crumbs">
        <Link href="/">Overview</Link>
        {store.region && <> › <Link href={`/region/${encodeURIComponent(store.region)}`}>{store.region}</Link></>}
        {" "}› {store.name}
      </div>

      <div className="panel">
        <div className="sh-top">
          <h3>{store.name}</h3>
          <StatusTag status={store.status} />
          <span className="sh-meta">{store.size_category} · shelf max {store.shelf_max} · {store.region}</span>
        </div>
        <div className="kpis">
          <div className="kpi">
            <div className="lbl">Sold this week</div>
            <div className="val">{store.total_sold.toLocaleString("en-AU")}</div>
            <div className={`cmp delta ${soldDelta >= 0 ? "up" : "down"}`}>
              {soldDelta >= 0 ? "▲" : "▼"} {Math.abs(soldDelta)}% vs last week
            </div>
          </div>
          <div className="kpi">
            <div className="lbl">Waste</div>
            <div className="val">{store.waste_pct}<span style={{ fontSize: ".5em", color: "var(--muted)" }}>%</span></div>
            <div className="cmp" style={{ color: "var(--muted)" }}>{store.total_wasted} units this week</div>
          </div>
          <div className="kpi">
            <div className="lbl">Stockout days</div>
            <div className="val">{store.stockout_days}</div>
            <div className="cmp" style={{ color: "var(--muted)" }}>of 7</div>
          </div>
        </div>
        {daily.length > 0 && (
          <>
            <div style={{ fontSize: 12, color: "var(--muted)", margin: "20px 0 8px" }}>Daily units this week — no running totals</div>
            <StoreBars data={daily} />
            <div style={{ display: "flex", gap: 16, fontSize: 11.5, color: "var(--ink2)", marginTop: 8 }}>
              <span><i style={{ width: 10, height: 10, borderRadius: 3, display: "inline-block", background: "#2a2019", marginRight: 5 }} />Sold</span>
              <span><i style={{ width: 10, height: 10, borderRadius: 3, display: "inline-block", background: "#e7ddca", marginRight: 5 }} />Delivered</span>
            </div>
          </>
        )}
      </div>

      {recos.length > 0 ? (
        <>
          <div className="section-h" style={{ marginBottom: 6 }}>
            <span className="tick" />Engine order recommendations{" "}
            <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, color: "var(--faint)" }}>· this week, sized to what actually sold</span>
          </div>
          <div style={{ fontSize: 13.5, color: "var(--muted)", margin: "0 0 14px" }}>
            You sent <b style={{ color: "var(--ink)" }}>{sentNow.toLocaleString("en-AU")}</b> units this week; the engine would send{" "}
            <b style={{ color: "var(--ink)" }}>{engineSend.toLocaleString("en-AU")}</b>
            {trimTotal > 0 ? <> — <b style={{ color: "var(--green)" }}>{trimTotal.toLocaleString("en-AU")} fewer</b>, right-sized to real demand.</> : <>.</>}
          </div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Product</th><th className="num">Sold</th><th className="num">Sending now</th><th className="num">Engine sends</th><th className="num">Change</th></tr>
              </thead>
              <tbody>
                {recos.map((r) => {
                  const d = r.sent - r.recommended;
                  return (
                    <tr key={r.product_name}>
                      <td className="strong">{r.product_name}</td>
                      <td className="num">{r.sold}</td>
                      <td className="num">{r.sent}</td>
                      <td className="num strong">{r.recommended}</td>
                      <td className="num" style={{ color: d > 0 ? "var(--green)" : d < 0 ? "var(--amber)" : "var(--muted)", fontWeight: 600 }}>
                        {d > 0 ? `−${d}` : d < 0 ? `+${-d}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="foot">
            &quot;Engine sends&quot; is the newsvendor order-up-to on this store&apos;s real sales, capped at shelf max — the manual call, right-sized.
            Green trims over-supply (less waste); amber adds cover where the shelf ran short. Woolworths mature feed.
          </div>
        </>
      ) : products.length > 0 ? (
        <>
          <div className="section-h" style={{ marginBottom: 12 }}><span className="tick" />Products this week</div>
          <div className="tablewrap">
            <table>
              <thead>
                <tr><th>Product</th><th>Status</th><th className="num">Sold</th><th className="num">Sent</th><th className="num">Waste %</th><th className="num">Suggested next</th></tr>
              </thead>
              <tbody>
                {products.map((p) => (
                  <tr key={p.name}>
                    <td className="strong">{p.name}</td>
                    <td><StatusTag status={p.status} /></td>
                    <td className="num">{p.sold}</td>
                    <td className="num">{p.sent}</td>
                    <td className="num">{p.waste_pct ?? 0}%</td>
                    <td className="num strong">{p.suggested ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="foot">
            &quot;Suggested next&quot; is populated by the forecasting service (newsvendor order-up-to, capped at shelf max).
            Dashes show where the engine hasn&apos;t written a plan for that product yet.
          </div>
        </>
      ) : (
        <div className="panel" style={{ marginTop: 4 }}>
          <div style={{ fontFamily: "var(--serif)", fontSize: 17, marginBottom: 6 }}>Per-product order plan is warming up for this store</div>
          <div style={{ color: "var(--ink2)", maxWidth: 640, lineHeight: 1.6 }}>
            The engine writes full per-product recommendations for stores on a mature sales feed — that&apos;s the Woolworths network today.
            This store&apos;s weekly totals are shown above; its line-by-line order plan lights up as its retailer feed fills in the ledger.
          </div>
        </div>
      )}
    </>
  );
}
