import Link from "next/link";
import type { StoreWeek, NetworkWeek } from "@/lib/queries";

const nf = (n: number) => n.toLocaleString("en-AU");

// Simona's "TODAY" dashboard, from the layout she drew: a headline strip, then
// the exception lists she asked for — Needs attention, Opportunities, Best
// performers, Biggest losses. Real numbers where we have them; the dollar
// figures are honest placeholders until the cost feed is wired in.
export default function TodayDashboard({ stores, net, asOf }: { stores: StoreWeek[]; net: NetworkWeek; asOf: string }) {
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

  // ---- needs attention ----
  const likelyStockouts = rows.filter((r) => r.stockouts > 0).length;
  const excessiveWaste = rows.filter((r) => r.waste != null && r.waste > 25).length;
  const abnormalDeclines = rows.filter((r) => r.growth != null && r.growth < -10).length;
  const allocationOpps = rows.filter((r) => r.sent - r.sold > Math.max(20, r.sold * 0.2)).length;

  // ---- opportunities ----
  const couldIncrease = rows.filter((r) => r.stockouts > 0).length;
  const couldExpandRange = rows.filter((r) => r.sellThrough != null && r.sellThrough >= 95 && (r.waste == null || r.waste < 12)).length;
  const outperforming = rows.filter((r) => r.s.status === "green" && r.sellThrough != null && r.sellThrough >= 92).length;

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
      <div className="t-locked">
        <span className="lk">🔒 Unlocks with the cost feed</span>
        <span className="lkm">Sales this week</span>
        <span className="lkm">Estimated waste $</span>
        <span className="lkm">Profit</span>
        <span className="lknote">the per-unit figures already sit in the retailer data</span>
      </div>

      <div className="t-cols">
        <div className="t-card attn">
          <div className="t-ch"><span className="ic">⚠</span> Needs attention</div>
          <StatLine n={likelyStockouts} label="likely stockouts" tone="r" href="/stores?view=stockouts" />
          <StatLine n={excessiveWaste} label="excessive waste (>25%)" tone="r" href="/stores?view=waste25" />
          <StatLine n={abnormalDeclines} label="abnormal sales declines" tone="a" href="/stores?view=declines" />
          <StatLine n={allocationOpps} label="allocation opportunities" tone="a" href="/stores?view=overdeliver" />
        </div>
        <div className="t-card opp">
          <div className="t-ch"><span className="ic">📈</span> Opportunities</div>
          <StatLine n={couldIncrease} label="stores could increase supply" tone="g" href="/stores?view=stockouts" />
          <StatLine n={couldExpandRange} label="stores could expand range" tone="g" href="/stores?view=expandrange" />
          <StatLine n={outperforming} label="outperforming comparable stores" tone="g" href="/stores?view=outperform" />
        </div>
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

function StatLine({ n, label, tone, href }: { n: number; label: string; tone: "r" | "a" | "g"; href?: string }) {
  const inner = (
    <>
      <span className={`sn ${tone}`}>{n}</span>
      <span className="sl">{label}</span>
    </>
  );
  // Drill to exactly this set — but only when there's something to see. A zero
  // count links nowhere (nothing to drill into).
  if (href && n > 0) {
    return (
      <Link href={href} className="t-stat lk">
        {inner}
        <span className="go">→</span>
      </Link>
    );
  }
  return <div className="t-stat">{inner}</div>;
}
