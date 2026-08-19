import Link from "next/link";
import type { StoreWeek, NetworkWeek } from "@/lib/queries";

const nf = (n: number) => n.toLocaleString("en-AU");

// Simona's "TODAY" dashboard, from the layout she drew: a headline strip, then
// the exception lists she asked for — Needs attention, Opportunities, Best
// performers, Biggest losses. Real numbers where we have them; the dollar
// figures are honest placeholders until the cost feed is wired in.
export default function TodayDashboard({ stores, net, asOf, revenue = null }: { stores: StoreWeek[]; net: NetworkWeek; asOf: string; revenue?: { salesWk: number; wasteWk: number } | null }) {
  const rows = stores.map((s) => {
    const sold = Number(s.total_sold) || 0;
    const sent = Number(s.total_sent) || 0;
    const wasted = Number(s.total_wasted) || 0;
    const prev = Number(s.total_sold_prev) || 0;
    const waste = s.waste_pct == null ? null : Number(s.waste_pct);
    const stockouts = Number(s.stockout_days) || 0;
    const sellThrough = sent > 0 ? (sold / sent) * 100 : null;
    const growth = prev > 0 ? ((sold - prev) / prev) * 100 : null;
    return { s, sold, sent, wasted, waste, stockouts, sellThrough, growth };
  });

  // ---- headline ----
  const netSent = Number(net.total_sent) || 0;
  const netSold = Number(net.total_sold) || 0;
  const netSellThrough = netSent > 0 ? Math.round((1000 * netSold) / netSent) / 10 : null;
  const netWaste = net.waste_pct == null ? null : Number(net.waste_pct);

  // ---- Today's action list (Simona's format: issue -> action) ----
  // "High wastage" = the RAG red waste threshold (>30%, per jb_status). Anything
  // 20-30% is amber ("to watch"), not a "reduce production now" call — so this
  // stays at >30 to match the status dots used everywhere else in the app.
  const highWastage = rows.filter((r) => r.waste != null && r.waste > 30).length;
  const stockOuts = rows.filter((r) => r.stockouts > 0).length;
  const salesDecline = rows.filter((r) => r.growth != null && r.growth < -10).length;
  const strongSellers = rows.filter((r) => r.sellThrough != null && r.sellThrough >= 95 && (r.waste == null || r.waste < 12)).length;
  // "Need attention today" mirrors the hero's red count exactly (status === red,
  // i.e. waste >30 or >=3 stockout days). Deriving it from the same RAG status
  // keeps this header locked in lockstep with the hero and the region cards —
  // one "needs attention" number on the page, never 56 here and 68 there.
  const needAttention = rows.filter((r) => r.s.status === "red").length;
  // dataPending: the sales-trend signals stay at 0 until the daily history loads
  // — flag that rather than implying "all clear".
  const actions = [
    { key: "waste", tone: "red", n: highWastage, issue: "high wastage", action: "Reduce production", href: "/stores?view=waste30", pending: false },
    { key: "stock", tone: "amber", n: stockOuts, issue: "lines selling out", action: "Increase allocation", href: "/stores?view=stockouts", pending: true },
    { key: "decline", tone: "blue", n: salesDecline, issue: "sudden sales decline", action: "Investigate", href: "/stores?view=declines", pending: true },
    { key: "growth", tone: "green", n: strongSellers, issue: "strong sellers", action: "Consider expanding range", href: "/stores?view=expandrange", pending: false },
  ] as const;

  // ---- best performers: high sell-through, low waste ----
  // Retail-scan stores only. Direct-invoice stores (cafes/schools) invoice
  // exactly what they sell, so they sit at 100%/0% by definition and would
  // fill this list with structural perfection, telling Simona nothing. This
  // surfaces genuinely well-run RETAIL stores.
  const best = [...rows]
    .filter((r) => r.sellThrough != null && r.s.retailer !== "invoice")
    .sort((a, b) => (b.sellThrough! - (b.waste ?? 0)) - (a.sellThrough! - (a.waste ?? 0)))
    .slice(0, 10);

  // ---- biggest losses: most wasted units ----
  const losses = [...rows].sort((a, b) => b.wasted - a.wasted).slice(0, 10);

  return (
    <section className="today">
      <div className="t-head">
        <span className="t-lbl">Today</span>
        <span className="t-date">{asOf}</span>
        <span className="t-note">date picker &amp; live $ next phase</span>
      </div>

      <div className="t-strip">
        <div className="t-tile"><div className="tv">{nf(net.stores)}</div><div className="tl">Active stores supplied</div></div>
        <div className="t-tile"><div className="tv g">{netSellThrough == null ? "—" : `${netSellThrough}%`}</div><div className="tl">Sell-through</div></div>
        <div className="t-tile"><div className={`tv ${netWaste != null && netWaste <= 20 ? "g" : "a"}`}>{netWaste == null ? "—" : `${netWaste}%`}</div><div className="tl">Network waste</div></div>
      </div>
      {revenue ? (
        <div className="t-strip" style={{ marginTop: 12 }}>
          <div className="t-tile"><div className="tv">${nf(revenue.salesWk)}</div><div className="tl">Sales this week · revenue</div></div>
          <div className="t-tile"><div className="tv a">${nf(revenue.wasteWk)}</div><div className="tl">Waste this week · $ (revenue-weighted)</div></div>
          <div className="t-tile"><div className="tv dim">$ —</div><div className="tl">Profit · needs Simona&apos;s production cost</div></div>
        </div>
      ) : (
        <div className="t-locked">
          <span className="lk">🔒 Unlocks with the cost feed</span>
          <span className="lkm">Sales this week</span>
          <span className="lkm">Estimated waste $</span>
          <span className="lkm">Profit</span>
          <span className="lknote">the per-unit figures already sit in the retailer data</span>
        </div>
      )}

      <div className="t-actions">
        <div className="ta-h">
          <span className="ta-t">📋 Today&apos;s action list</span>
          <span className="ta-c"><b>{needAttention}</b> {needAttention === 1 ? "store needs" : "stores need"} attention</span>
        </div>
        {actions.map((a) => {
          const inner = (
            <>
              <span className={`ta-dot ${a.tone}`} />
              <span className="ta-n">{a.n}</span>
              <span className="ta-issue">{a.n === 1 ? "store" : "stores"} — {a.issue}</span>
              <span className="ta-sep">→</span>
              <span className="ta-do">{a.action}</span>
            </>
          );
          return a.n > 0 ? (
            <Link key={a.key} href={a.href} className="ta-row lk">{inner}<span className="ta-go">›</span></Link>
          ) : (
            <div key={a.key} className="ta-row off">{inner}<span className="ta-note">{a.pending ? "fills as the sales history loads" : "none flagged"}</span></div>
          );
        })}
      </div>

      <div className="t-cols">
        <div className="t-list">
          <div className="t-lh"><span>🔥 Best performers</span><span className="sub">sell-through · waste</span></div>
          {best.map((r, i) => (
            <Link key={r.s.store_id} href={`/store/${r.s.store_id}`} className="t-row">
              <span className="rk">{i + 1}</span>
              <span className="nm">{r.s.name}<small>{r.s.region ?? "—"}</small></span>
              <span className="mv g">{r.sellThrough == null ? "—" : `${Math.round(r.sellThrough)}%`}</span>
              <span className="mv2">{r.waste == null ? "—" : `${r.waste}%`}</span>
            </Link>
          ))}
          {best.length === 0 && <div className="t-empty">Lights up as the sales feed fills.</div>}
        </div>
        <div className="t-list">
          <div className="t-lh"><span>🚨 Biggest losses</span><span className="sub">wasted units · waste</span></div>
          {losses.map((r, i) => (
            <Link key={r.s.store_id} href={`/store/${r.s.store_id}`} className="t-row">
              <span className="rk">{i + 1}</span>
              <span className="nm">{r.s.name}<small>{r.s.region ?? "—"}</small></span>
              <span className="mv r">{nf(r.wasted)}</span>
              <span className="mv2">{r.waste == null ? "—" : `${r.waste}%`}</span>
            </Link>
          ))}
          {losses.length === 0 && <div className="t-empty">Lights up as the sales feed fills.</div>}
        </div>
      </div>

      <style>{`
      .today{display:block;margin:6px 0 24px}
      .today .t-head{display:flex;align-items:baseline;gap:12px;margin-bottom:12px}
      .today .t-lbl{font-family:var(--serif);font-size:18px;font-weight:600;letter-spacing:-.2px}
      .today .t-date{font-size:12.5px;color:var(--ink2);font-weight:600}
      .today .t-note{margin-left:auto;font-size:11px;color:var(--faint)}
      .today .t-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line2);border:1px solid var(--line2);border-radius:12px;overflow:hidden}
      @media(max-width:520px){.today .t-strip{grid-template-columns:1fr}}
      .today .t-tile{background:var(--card);padding:14px 16px}
      .today .t-tile .tv{font-family:var(--serif);font-size:23px;font-weight:600;letter-spacing:-.4px;font-variant-numeric:tabular-nums;line-height:1}
      .today .t-tile .tv.g{color:var(--green-t)}.today .t-tile .tv.a{color:var(--amber-t)}
      .today .t-tile .tl{font-size:11px;color:var(--muted);margin-top:6px}
      .today .t-locked{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;margin:10px 2px 18px}
      .today .t-locked .lk{font-size:11.5px;font-weight:700;color:var(--muted);letter-spacing:.2px}
      .today .t-locked .lkm{font-size:11.5px;color:var(--faint);border:1px dashed var(--line2);border-radius:6px;padding:2px 8px}
      .today .t-locked .lknote{font-size:11px;color:var(--faint);font-style:italic}
      @media(max-width:520px){.today .t-locked .lknote{width:100%}}

      .today .t-actions{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden;margin-bottom:16px}
      .today .ta-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid var(--line2)}
      .today .ta-t{font-family:var(--serif);font-size:16px;font-weight:600}
      .today .ta-c{font-size:12.5px;color:var(--muted)}
      .today .ta-c b{color:var(--ink);font-variant-numeric:tabular-nums}
      .today .ta-row{display:flex;align-items:center;gap:11px;padding:12px 16px;border-bottom:1px solid var(--line2);font-size:13.5px}
      .today .ta-row:last-child{border-bottom:none}
      .today .ta-dot{width:11px;height:11px;border-radius:50%;flex:none}
      .today .ta-dot.red{background:var(--red)}.today .ta-dot.amber{background:var(--amber)}.today .ta-dot.green{background:var(--green)}.today .ta-dot.blue{background:#4b7fc0}
      .today .ta-n{font-family:var(--serif);font-size:19px;font-weight:600;font-variant-numeric:tabular-nums;min-width:30px;text-align:right}
      .today .ta-issue{color:var(--ink);font-weight:600}
      .today .ta-sep{color:var(--faint);font-weight:700}
      .today .ta-do{color:var(--ink2)}
      .today a.ta-row{text-decoration:none;color:inherit;transition:background .12s}
      .today a.ta-row.lk:hover{background:#faf6ee}
      .today .ta-go{margin-left:auto;color:var(--faint);font-weight:700;font-size:16px}
      .today a.ta-row.lk:hover .ta-go{color:var(--crust-deep)}
      .today .ta-row.off{opacity:.7}
      .today .ta-row.off .ta-n{color:var(--faint)}
      .today .ta-note{margin-left:auto;font-size:11.5px;color:var(--faint);font-style:italic}
      @media(max-width:560px){.today .ta-do{display:none}.today .ta-sep{display:none}}

      .today .t-cols{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
      @media(max-width:820px){.today .t-cols{grid-template-columns:1fr}}
      .today .t-card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px}
      .today .t-card.attn{background:linear-gradient(160deg,#fffaf6,#fbf1ea)}
      .today .t-card.opp{background:linear-gradient(160deg,#fbfdf8,#f0f5ea)}
      .today .t-ch{font-size:13px;font-weight:700;color:var(--ink);margin-bottom:10px;display:flex;align-items:center;gap:8px}
      .today .t-ch .ic{font-size:13px}
      .today .t-list{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden}
      .today .t-lh{display:flex;justify-content:space-between;align-items:baseline;padding:13px 16px;border-bottom:1px solid var(--line2);font-family:var(--serif);font-size:15px;font-weight:600}
      .today .t-lh .sub{font-family:var(--sans);font-size:10.5px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.4px}
      .today .t-row{display:grid;grid-template-columns:24px 1fr auto auto;align-items:center;gap:12px;padding:9px 16px;border-bottom:1px solid var(--line2);transition:background .12s}
      .today .t-row:last-child{border-bottom:none}
      .today .t-row:hover{background:#faf6ee}
      .today .t-row .rk{font-size:12px;color:var(--faint);font-weight:700;font-variant-numeric:tabular-nums}
      .today .t-row .nm{font-weight:600;font-size:13.5px;line-height:1.2}
      .today .t-row .nm small{display:block;font-weight:400;color:var(--muted);font-size:11px;margin-top:1px}
      .today .t-row .mv{font-weight:700;font-size:13.5px;font-variant-numeric:tabular-nums;text-align:right}
      .today .t-row .mv.g{color:var(--green-t)}.today .t-row .mv.r{color:var(--red-t)}
      .today .t-row .mv2{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;text-align:right;min-width:44px}
      .today .t-empty{padding:16px;color:var(--faint);font-size:12.5px}
      .today .t-stat{display:flex;align-items:baseline;gap:10px;padding:7px 0;border-bottom:1px solid var(--line2)}
      .today .t-stat:last-child{border-bottom:none}
      .today .t-stat .sn{font-family:var(--serif);font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;min-width:34px}
      .today .t-stat .sn.r{color:var(--red-t)}.today .t-stat .sn.a{color:var(--amber-t)}.today .t-stat .sn.g{color:var(--green-t)}
      .today .t-stat .sl{font-size:13px;color:var(--ink2)}
      a.t-stat.lk{text-decoration:none;cursor:pointer;transition:background .12s;margin:0 -8px;padding-left:8px;padding-right:8px;border-radius:7px}
      a.t-stat.lk:hover{background:#faf6ee}
      a.t-stat.lk .go{margin-left:auto;color:var(--faint);font-weight:700;font-size:13px}
      a.t-stat.lk:hover .go{color:var(--crust-deep)}
      a.t-stat.lk:hover .sl{color:var(--crust-deep)}
      `}</style>
    </section>
  );
}

