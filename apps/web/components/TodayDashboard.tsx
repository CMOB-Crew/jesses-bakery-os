"use client";
import Link from "next/link";
import { useState } from "react";
import type { StoreWeek, NetworkWeek } from "@/lib/queries";
import { isCapStale, type ShelfCapOverride } from "@/lib/shelfcap";

const nf = (n: number) => n.toLocaleString("en-AU");
const RETAILER: Record<string, string> = {
  woolworths: "Woolworths", coles: "Coles", harris_farm: "Harris Farm",
  invoice: "invoice customers",
};

// Median without pulling in the server-only queries helper.
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
}

// Fold the size enum (small/medium/large/xlarge, or null) into the three bands
// Simona uses. xlarge sits with Large; unsized stores drop out of the size view.
type Band = "small" | "medium" | "large";
const BANDS: { key: Band; label: string; range: string }[] = [
  { key: "small", label: "Small", range: "50–60" },
  { key: "medium", label: "Medium", range: "60–90" },
  { key: "large", label: "Large", range: "82–140" },
];
function bandOf(size: string | null): Band | null {
  if (!size) return null;
  const s = size.toLowerCase();
  if (s === "small") return "small";
  if (s === "medium") return "medium";
  if (s === "large" || s === "xlarge") return "large";
  return null;
}

// Simona's "TODAY" dashboard, from the layout she drew: a headline strip, then
// the exception lists she asked for — Needs attention, Opportunities, Best
// performers, Biggest losses. Real numbers where we have them; the dollar
// figures are honest placeholders until the cost feed is wired in.
//
// Session 2 (UAT) change: a flat waste % hides size. 20% at a Large store that
// sends 120 is fine; 20% at a Small store that sends 50 is not. So the two lists
// can be filtered to Small / Medium / Large, each list shows the wasted UNIT
// count next to the %, and a per-size strip shows what the typical % is in units.
export default function TodayDashboard({ stores, net, asOf, revenue = null, thresholds = null, states = {}, revByStore = {}, capOverrides = {}, peakDay = {} }: { stores: StoreWeek[]; net: NetworkWeek; asOf: string; revenue?: { salesWk: number; wasteWk: number } | null; thresholds?: { small: number; medium: number; large: number } | null; states?: Record<string, string>; revByStore?: Record<string, { rev: number; aur: number | null }>; capOverrides?: Record<string, ShelfCapOverride>; peakDay?: Record<string, number> }) {
  // Waste thresholds per size, from Settings (Simona sets her own; these floats
  // are the starting point she reviewed on the call until she confirms).
  const th = { small: 16, medium: 20, large: 25, ...(thresholds ?? {}) };
  const [band, setBand] = useState<Band | "all">("all");

  // State filter (NSW/ACT/QLD). The trap here: the headline tiles read a
  // server-side network aggregate while the lists below are built from these
  // client rows. Filter one without the other and the headline silently
  // disagrees with the list. So when a state is picked, EVERY figure on this
  // page — tiles, sell-through, waste, revenue — is recomputed from the
  // filtered rows. Unfiltered, the tiles keep using the server aggregate, so
  // today's numbers are untouched.
  const [stateF, setStateF] = useState("all");
  const stateOpts = [...new Set(Object.values(states))].sort();
  const scoped = stateF === "all" ? stores : stores.filter((s) => states[s.store_id] === stateF);

  const rows = scoped.map((s) => {
    const sold = Number(s.total_sold) || 0;
    const sent = Number(s.total_sent) || 0;
    const wasted = Number(s.total_wasted) || 0;
    const prev = Number(s.total_sold_prev) || 0;
    const waste = s.waste_pct == null ? null : Number(s.waste_pct);
    const stockouts = Number(s.stockout_days) || 0;
    const sellThrough = sent > 0 ? (sold / sent) * 100 : null;
    const growth = prev > 0 ? ((sold - prev) / prev) * 100 : null;
    return { s, sold, sent, wasted, waste, stockouts, sellThrough, growth, band: bandOf(s.size_category) };
  });

  // ---- headline ----
  // Every RATIO here is computed over the stores whose sales we can actually
  // see, and nothing else. Jesse delivers to 265 stores but only 95 of them
  // report a scan sale back; the rest are invoice customers who never will.
  // Divide what those 95 sold by what all 265 received and you get the answer
  // the Overview used to give — 15.6% waste, 29.6% sell-through — sitting
  // directly under an engine panel saying 34.3%, both from the same rows.
  // Migration 027 already refuses to score an invoice customer's waste; this is
  // the same refusal applied to the network total. See migration 031.
  //
  // Waste is inferred as delivered minus sold: the reported wastage table is
  // empty in prod, so there is nothing else to read.
  const filtered = stateF !== "all";
  const measured = rows.filter((r) => r.s.has_sales_feed !== false && r.waste != null);
  const rowSent = measured.reduce((a, r) => a + r.sent, 0);
  const rowSold = measured.reduce((a, r) => a + r.sold, 0);
  const netSent = filtered ? rowSent : Number(net.feed_sent) || 0;
  const netSold = filtered ? rowSold : Number(net.feed_sold) || 0;
  const netSellThrough = netSent > 0 ? Math.round((1000 * netSold) / netSent) / 10 : null;
  const netWaste = filtered
    ? rowSent > 0
      ? Math.round((1000 * measured.reduce((a, r) => a + Math.max(0, r.sent - r.sold), 0)) / rowSent) / 10
      : null
    : net.waste_pct == null
      ? null
      : Number(net.waste_pct);
  // Two different counts, deliberately: how many stores Jesse supplies, and how
  // many of them the percentages above are actually about.
  const netStores = filtered ? rows.length : Number(net.stores) || 0;
  const measuredStores = filtered ? measured.length : Number(net.feed_stores) || 0;
  // Revenue tiles follow the same rule — recomputed per store rather than
  // hidden, so a filtered view still answers "what is this state worth".
  const rev = filtered
    ? rows.reduce(
        (acc, r) => {
          const m = revByStore[r.s.store_id];
          if (m) {
            acc.salesWk += m.rev;
            if (m.aur != null) acc.wasteWk += Math.max(0, r.sent - r.sold) * m.aur;
          }
          return acc;
        },
        { salesWk: 0, wasteWk: 0 },
      )
    : revenue;

  // ---- What the dollar figures are actually ABOUT ----
  //
  // The two ratio tiles above already name their population ("the same 95
  // stores"). The dollar tiles didn't, and that is the worse omission of the
  // two: a percentage at least announces itself as a proportion, while
  // "$92,931 — Sold this week" reads as the whole business.
  //
  // It isn't. Revenue is priced per store off the Invoice_Cost feed, which only
  // covers stores whose sales we can see. On 26 Aug that is 45% of what Jesse
  // delivers. The other 55% — 115 Coles stores whose feed died on 3 Aug, plus
  // the invoice customers who have no price on file — carries no dollar value
  // at all. Not a low one. None.
  //
  // Computed rather than written down, so the note shrinks on its own as the
  // feeds come online and disappears when everything is priced.
  const pricedUnits = rows.reduce((a, r) => a + (revByStore[r.s.store_id] ? r.sent : 0), 0);
  const totalUnits = rows.reduce((a, r) => a + r.sent, 0);
  const pricedPct = totalUnits > 0 ? Math.round((1000 * pricedUnits) / totalUnits) / 10 : null;
  const unpricedUnits = totalUnits - pricedUnits;
  // Name the biggest unpriced retailer, because "55% is missing" invites the
  // question and the answer is nearly always one retailer at a time.
  const darkTop = (() => {
    const m = new Map<string, number>();
    for (const r of rows) if (!revByStore[r.s.store_id] && r.sent > 0) m.set(r.s.retailer, (m.get(r.s.retailer) ?? 0) + r.sent);
    const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? { retailer: RETAILER[top[0]] ?? top[0], units: top[1] } : null;
  })();

  // ---- Today's action list (Simona's format: issue -> action) ----
  const highWastage = rows.filter((r) => r.waste != null && r.waste > 30).length;
  // "Increase allocation" only where sending more is actually the answer.
  //
  // Any sell-out used to qualify. With the on-hand ledger loaded that became
  // 172 of 265 stores telling Simona to send more -- in a network running 34.3%
  // waste, on the same screen that tells her 64 stores are over-supplying. The
  // two lines contradict each other and the wrong one is more prominent.
  //
  // A store wasting 30%+ that also runs out of two lines does not need more
  // bread; it needs the same bread allocated differently across its range, and
  // the high-wastage row above already has it. So a sell-out is only actionable
  // as "send more" where waste is under Simona's 20% comfort line -- or where we
  // cannot measure waste at all, in which case the sell-out is the only signal
  // there is and she should see it.
  const stockOuts = rows.filter(
    (r) => r.stockouts > 0 && (r.waste == null || r.waste < 20),
  ).length;
  const salesDecline = rows.filter((r) => r.growth != null && r.growth < -10).length;
  const strongSellers = rows.filter((r) => r.sellThrough != null && r.sellThrough >= 95 && (r.waste == null || r.waste < 12)).length;
  const needAttention = rows.filter((r) => r.s.status === "red").length;

  // Shelf caps that can't be true. Simona asked for this one twice on the 26 Aug
  // call: once as a colour on the store page so she can spot it, and once here —
  // "will this alert also come somewhere else when I have my action items?" It
  // belongs in the list because it is the only row that isn't about bread: it's
  // a piece of reference data that is wrong, and every plan for that store is
  // being computed against it until someone types the real number in.
  //
  // Judged against the store's BUSIEST DAY, not its week. Against the week this
  // row read "84 stores" — 88% of everything we can measure, which is a wall,
  // not an action. Against the day it reads one. See lib/shelfcap.ts.
  //
  // Same predicate as the store page and the drill-down, imported rather than
  // rewritten, so this count and that list can never disagree.
  const capStale = rows.filter((r) => isCapStale(r.s, capOverrides[r.s.store_id], peakDay[r.s.store_id])).length;

  const actions = [
    { key: "waste", tone: "red", n: highWastage, issue: "high wastage", action: "Reduce production", href: "/stores?view=waste30", pending: false },
    { key: "stock", tone: "amber", n: stockOuts, issue: "lines selling out", action: "Increase allocation", href: "/stores?view=stockouts", pending: true },
    { key: "cap", tone: "violet", n: capStale, issue: "shelf cap smaller than a day's sales", action: "Check the real shelf size", href: "/stores?view=capstale", pending: false },
    { key: "decline", tone: "blue", n: salesDecline, issue: "sudden sales decline", action: "Investigate", href: "/stores?view=declines", pending: true },
    { key: "growth", tone: "green", n: strongSellers, issue: "strong sellers", action: "Consider expanding range", href: "/stores?view=expandrange", pending: false },
  ] as const;

  // ---- per-size summary: what the typical waste % is, and what it is in units ----
  // Retail scan stores only, with real sent + a size. Median % and median wasted
  // units per band, so Simona can read "20% here means ~X loaves" at a glance.
  const bandStats = BANDS.map((b) => {
    const inBand = rows.filter((r) => r.band === b.key && r.s.retailer !== "invoice" && r.sent > 0);
    // Only stores that actually report sales have a waste figure. The rest are
    // UNKNOWN, not zero.
    //
    // This used to be median(inBand.map(r => r.waste ?? 0)) -- every store with
    // no feed counted as 0% waste. Medium band is 166 stores, most of them Coles
    // with a feed dead since 7 Aug, so the median of mostly-zeros came out at
    // 0.0% while those same stores sat in Biggest Losses at 40-60%. Two panels
    // on one screen contradicting each other.
    //
    // Same mistake as coalesce(recommended, 0) in the delivery plan and the
    // no-feed stores in the waste denominator. Null is not zero.
    const measured = inBand.filter((r) => r.waste != null);
    const medWaste = median(measured.map((r) => r.waste as number));
    const limit = th[b.key];
    // Flag the band's typical waste against Simona's per-size threshold: red over
    // the limit, amber within 4 pts of it, green clear. Null medWaste = no tone.
    const tone = medWaste == null ? "" : medWaste > limit ? "r" : medWaste >= limit - 4 ? "a" : "g";
    return {
      ...b,
      count: inBand.length,
      measuredCount: measured.length,
      medWaste,
      medUnits: median(measured.map((r) => r.wasted)),
      limit,
      tone,
      overCount: measured.filter((r) => (r.waste as number) > limit).length,
    };
  });

  // ---- best performers: high sell-through, low waste ----
  // Retail-scan stores only. Direct-invoice stores (cafes/schools) invoice
  // exactly what they sell, so they sit at 100%/0% by definition. Filtered to the
  // selected size band when one is picked.
  const inSelected = (b: Band | null) => band === "all" || b === band;
  const best = rows
    .filter((r) => r.sellThrough != null && r.s.retailer !== "invoice" && inSelected(r.band))
    .sort((a, b) => (b.sellThrough! - (b.waste ?? 0)) - (a.sellThrough! - (a.waste ?? 0)))
    .slice(0, 10);

  // ---- biggest losses: most wasted units ----
  const losses = rows.filter((r) => inSelected(r.band)).sort((a, b) => b.wasted - a.wasted).slice(0, 10);

  const bandLabel = band === "all" ? "all sizes" : BANDS.find((b) => b.key === band)!.label + " stores";

  return (
    <section className="today">
      <div className="t-head">
        <span className="t-lbl">Today</span>
        <span className="t-date">{asOf}</span>
        <span className="t-note">date picker &amp; live $ next phase</span>
      </div>

      {stateOpts.length > 1 && (
        <div className="t-states">
          <button type="button" className={`t-spill ${stateF === "all" ? "on" : ""}`} onClick={() => setStateF("all")}>All states</button>
          {stateOpts.map((st) => (
            <button type="button" key={st} className={`t-spill ${stateF === st ? "on" : ""}`} onClick={() => setStateF(st)}>{st}</button>
          ))}
          {filtered && <span className="t-snote">Every number below is {stateF} only.</span>}
        </div>
      )}

      <div className="t-strip">
        <div className="t-tile"><div className="tv">{nf(netStores)}</div><div className="tl">{filtered ? `Stores supplied · ${stateF}` : "Active stores supplied"}</div></div>
        <div className="t-tile"><div className="tv g">{netSellThrough == null ? "—" : `${netSellThrough}%`}</div><div className="tl">Sell-through · {nf(measuredStores)} stores that report sales</div></div>
        <div className="t-tile"><div className={`tv ${netWaste != null && netWaste <= 20 ? "g" : "a"}`}>{netWaste == null ? "—" : `${netWaste}%`}</div><div className="tl">Waste · the same {nf(measuredStores)} stores</div></div>
      </div>
      {rev ? (
        <div className="t-strip" style={{ marginTop: 12 }}>
          {/* "Sold" and "unsold", not "sales" and "waste". The two dollar
              figures are priced off the same per-unit revenue, so they invite
              being divided into each other — and $49,935 against $92,931 reads
              54%, not the 34.5% in the tile above. Both are right: 34.5% of what
              was DELIVERED came back, and that stock is worth 53% of what SOLD.
              Different denominators, and the old labels ("Sales" / "Waste $")
              gave no hint of that. Sold-vs-unsold names the pair for what it is
              and stops the wrong division looking meaningful. */}
          <div className="t-tile"><div className="tv">${nf(Math.round(rev.salesWk))}</div><div className="tl">Sold this week · the same {nf(measuredStores)} stores</div></div>
          <div className="t-tile"><div className="tv a">${nf(Math.round(rev.wasteWk))}</div><div className="tl">Unsold this week · what it would have sold for</div></div>
          <div className="t-tile"><div className="tv dim">$ —</div><div className="tl">Profit · needs Simona&apos;s production cost</div></div>
        </div>
      ) : (
        <div className="t-locked">
          <span className="lk">🔒 Unlocks with the cost feed</span>
          <span className="lkm">Sold this week</span>
          <span className="lkm">Unsold this week</span>
          <span className="lkm">Profit</span>
          <span className="lknote">the per-unit figures already sit in the retailer data</span>
        </div>
      )}

      {/* The scope of the dollars, stated where the dollars are. Without this the
          three tiles above read as the whole bakery; they are 45% of it. */}
      {rev && pricedPct != null && pricedPct < 99 && (
        <div className="t-scope">
          <b>These dollars cover {pricedPct}% of what Jesse delivers.</b> We can only
          price a store whose sales we can see, so <b>{nf(unpricedUnits)} units a week</b>
          {darkTop ? <> — mostly {darkTop.retailer}, {nf(darkTop.units)} of them</> : null} carry
          no dollar figure at all. Not a low one: none. The units and percentages above
          say which stores they are about; these three say it here.
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

      {/* ---- Waste by store size: the same % means different things by size ---- */}
      <div className="t-sizes">
        <div className="tsz-h">
          <span className="tsz-t">Waste by store size</span>
          <span className="tsz-sub">a flat % hides size — 20% of a 50-loaf shelf ≠ 20% of a 120-loaf one</span>
        </div>
        <div className="tsz-grid">
          <button className={`tsz-cell all ${band === "all" ? "on" : ""}`} onClick={() => setBand("all")}>
            <span className="tsz-lab">All sizes</span>
            <span className="tsz-big">{rows.filter((r) => r.s.retailer !== "invoice" && r.sent > 0).length}</span>
            <span className="tsz-u">retail stores</span>
          </button>
          {bandStats.map((b) => (
            <button key={b.key} className={`tsz-cell ${band === b.key ? "on" : ""}`} onClick={() => setBand(band === b.key ? "all" : b.key)}>
              <span className="tsz-lab">{b.label} <i>{b.range}</i></span>
              <span className="tsz-big"><span className={`tszv ${b.tone}`}>{b.medWaste == null ? "—" : `${b.medWaste}%`}</span><span className="tsz-count">{b.count} {b.count === 1 ? "store" : "stores"}</span></span>
              <span className="tsz-u">{b.medWaste == null ? "none reporting sales yet" : `${b.measuredCount} of ${b.count} reporting · limit ${b.limit}%${b.overCount > 0 ? ` · ${b.overCount} over` : " · all under"}`}</span>
            </button>
          ))}
        </div>
        {band !== "all" && (
          <div className="tsz-active">Showing <b>{bandLabel}</b> · <button className="tsz-clear" onClick={() => setBand("all")}>show all sizes</button></div>
        )}
      </div>

      <div className="t-cols">
        <div className="t-list">
          <div className="t-lh"><span>🔥 Best performers</span><span className="sub">sell-through · waste ·  units</span></div>
          {best.map((r, i) => (
            <Link key={r.s.store_id} href={`/store/${r.s.store_id}`} className="t-row">
              <span className="rk">{i + 1}</span>
              <span className="nm">{r.s.name}<small>{r.s.region ?? "—"}{r.band ? ` · ${r.band[0].toUpperCase()}${r.band.slice(1)}` : ""}</small></span>
              <span className="mv g">{r.sellThrough == null ? "—" : `${Math.round(r.sellThrough)}%`}</span>
              <span className="mv2">{r.waste == null ? "—" : `${r.waste}%`}<small>{nf(r.wasted)}u</small></span>
            </Link>
          ))}
          {best.length === 0 && <div className="t-empty">{band === "all" ? "Lights up as the sales feed fills." : `No ${bandLabel} with a scan feed yet.`}</div>}
        </div>
        <div className="t-list">
          <div className="t-lh"><span>🚨 Biggest losses</span><span className="sub">wasted units · waste %</span></div>
          {losses.map((r, i) => (
            <Link key={r.s.store_id} href={`/store/${r.s.store_id}`} className="t-row">
              <span className="rk">{i + 1}</span>
              <span className="nm">{r.s.name}<small>{r.s.region ?? "—"}{r.band ? ` · ${r.band[0].toUpperCase()}${r.band.slice(1)}` : ""}</small></span>
              <span className="mv r">{nf(r.wasted)}<small>units</small></span>
              <span className="mv2">{r.waste == null ? "—" : `${r.waste}%`}</span>
            </Link>
          ))}
          {losses.length === 0 && <div className="t-empty">{band === "all" ? "Lights up as the sales feed fills." : `No ${bandLabel} with waste yet.`}</div>}
        </div>
      </div>

      <style>{`
      .today{display:block;margin:6px 0 24px}
      .today .t-head{display:flex;align-items:baseline;gap:12px;margin-bottom:12px}
      .today .t-lbl{font-family:var(--serif);font-size:18px;font-weight:600;letter-spacing:-.2px}
      .today .t-date{font-size:12.5px;color:var(--ink2);font-weight:600}
      .today .t-note{margin-left:auto;font-size:11px;color:var(--faint)}
      .today .t-states{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px}
      .today .t-spill{border:1px solid #e6d3ad;background:#f6efe2;color:var(--ink2);border-radius:999px;padding:5px 14px;font-size:13px;font-weight:600;cursor:pointer}
      .today .t-spill.on{background:var(--card);color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.08)}
      .today .t-snote{font-size:12px;color:var(--muted);margin-left:4px}
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
      /* Violet is used for exactly one thing across the whole app: reference
         data we can prove is wrong. It reads as "check this", not "a store is
         performing badly", which is what every other colour on this list means.
         Same violet as the shelf-cap banner on the store page, so the alert she
         spots there and the row she sees here are visibly the same alert. */
      .today .ta-dot.violet{background:#7b5ea7}
      .today .t-scope{margin-top:10px;background:var(--card);border:1px solid var(--line2);border-left:3px solid var(--line);border-radius:10px;padding:10px 14px;font-size:12.5px;line-height:1.55;color:var(--ink2)}
      .today .t-scope b{color:var(--ink);font-weight:600}
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

      /* ---- waste by store size ---- */
      .today .t-sizes{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden;margin-bottom:16px}
      .today .tsz-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:13px 16px;border-bottom:1px solid var(--line2);flex-wrap:wrap}
      .today .tsz-t{font-family:var(--serif);font-size:16px;font-weight:600}
      .today .tsz-sub{font-size:11.5px;color:var(--muted)}
      .today .tsz-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--line2)}
      @media(max-width:640px){.today .tsz-grid{grid-template-columns:1fr 1fr}}
      .today .tsz-cell{background:var(--card);border:0;text-align:left;padding:13px 16px;cursor:pointer;display:flex;flex-direction:column;gap:3px;transition:background .12s;border-top:3px solid transparent;font:inherit}
      .today .tsz-cell:hover{background:#faf6ee}
      .today .tsz-cell.on{background:#fbf4ea;border-top-color:var(--crust-deep,#a7611c)}
      .today .tsz-cell.all.on{border-top-color:var(--ink2,#6b5b45)}
      .today .tsz-lab{font-size:11.5px;font-weight:700;color:var(--ink2);text-transform:uppercase;letter-spacing:.4px}
      .today .tsz-lab i{font-style:normal;color:var(--faint);font-weight:600;letter-spacing:0}
      .today .tsz-big{font-family:var(--serif);font-size:22px;font-weight:600;letter-spacing:-.4px;font-variant-numeric:tabular-nums;line-height:1.1;display:flex;align-items:baseline;gap:8px}
      .today .tszv.r{color:var(--red-t)}.today .tszv.a{color:var(--amber-t)}.today .tszv.g{color:var(--green-t)}
      .today .tsz-count{font-family:var(--sans);font-size:11px;color:var(--faint);font-weight:600;letter-spacing:0}
      .today .tsz-u{font-size:11px;color:var(--muted)}
      .today .tsz-active{padding:10px 16px;font-size:12px;color:var(--ink2);border-top:1px solid var(--line2);background:#fdfaf5}
      .today .tsz-active b{color:var(--ink)}
      .today .tsz-clear{border:0;background:0;color:var(--crust-deep,#a7611c);font:inherit;font-size:12px;cursor:pointer;text-decoration:underline;padding:0}

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
      .today .t-row{display:grid;grid-template-columns:24px 1fr auto auto;align-items:center;gap:12px;padding:9px 16px;border-bottom:1px solid var(--line2);transition:background .12s;text-decoration:none;color:inherit}
      .today .t-row:last-child{border-bottom:none}
      .today .t-row:hover{background:#faf6ee}
      .today .t-row .rk{font-size:12px;color:var(--faint);font-weight:700;font-variant-numeric:tabular-nums}
      .today .t-row .nm{font-weight:600;font-size:13.5px;line-height:1.2}
      .today .t-row .nm small{display:block;font-weight:400;color:var(--muted);font-size:11px;margin-top:1px}
      .today .t-row .mv{font-weight:700;font-size:13.5px;font-variant-numeric:tabular-nums;text-align:right;line-height:1.15}
      .today .t-row .mv.g{color:var(--green-t)}.today .t-row .mv.r{color:var(--red-t)}
      .today .t-row .mv small{display:block;font-weight:600;color:var(--faint);font-size:10px}
      .today .t-row .mv2{font-size:12.5px;color:var(--ink2);font-weight:700;font-variant-numeric:tabular-nums;text-align:right;min-width:44px;line-height:1.15}
      .today .t-row .mv2 small{display:block;font-weight:400;color:var(--faint);font-size:10px}
      .today .t-empty{padding:16px;color:var(--faint);font-size:12.5px}
      `}</style>
    </section>
  );
}
