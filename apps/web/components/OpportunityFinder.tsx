"use client";
import { useMemo, useState } from "react";

/* ------------------------------------------------------------------ *
 * Opportunity finder — one ranked list of the biggest wins across the
 * network, pulling the three levers together: trim waste where we
 * over-send, capture demand where we sell out, and add range where a
 * store is missing an obvious line. This is the surface behind Simona's
 * "where can we make another $20k/month?" — ranked by units at stake
 * now; it weights by revenue once the price feed (Invoice_Cost) lands,
 * and answers the profit question once Simona's production cost is in.
 *
 * Note: Invoice_Cost is what the retailer pays Jesse = revenue, not
 * margin. So the dollar layer is revenue-weighted until production cost
 * exists. Front-end prototype; the ranking is the engine's, this surfaces it.
 * ------------------------------------------------------------------ */

type Lever = "demand" | "waste" | "range" | "rebalance";
type Opp = {
  id: string; lever: Lever; store: string; region: string; product: string;
  situation: string; move: string; gain: number; conf: "high" | "medium";
};

const LEVER_META: Record<Lever, { label: string; verb: string; c: string; b: string }> = {
  demand:    { label: "Capture demand", verb: "Capture", c: "var(--green-t)", b: "var(--green-b)" },
  waste:     { label: "Trim waste",     verb: "Trim",    c: "var(--crust-deep)", b: "rgba(176,116,28,.13)" },
  range:     { label: "Add range",      verb: "Range",   c: "#4f7396", b: "rgba(79,115,150,.13)" },
  rebalance: { label: "Rebalance",      verb: "Shift",   c: "#8a5aa0", b: "rgba(138,90,160,.13)" },
};

const OPPS: Opp[] = [
  { id: "o1", lever: "demand", store: "Coles Belconnen", region: "Canberra / ACT", product: "White sourdough",
    situation: "Only 2 drops/week — sells out Wednesday before the Thursday delivery, week after week.",
    move: "Add a third weekly run, or lift the Monday send 24 → 32.", gain: 12, conf: "medium" },
  { id: "o2", lever: "range", store: "Coles Ashfield", region: "Inner West", product: "Mini bagels",
    situation: "Doesn't carry mini bagels, but every similar-size Coles on this run sells ~15/wk.",
    move: "Range mini bagels — seed 12/wk and let it find its level.", gain: 15, conf: "medium" },
  { id: "o3", lever: "waste", store: "Woolworths Gungahlin", region: "Canberra / ACT", product: "White sourdough",
    situation: "Over-sent on Sundays — 63% of the Sunday drop goes to waste, week in week out.",
    move: "Cut the Sunday send 24 → 15 to match real Sunday sell-through.", gain: 9, conf: "high" },
  { id: "o4", lever: "demand", store: "Woolworths Bondi Junction", region: "Eastern Suburbs", product: "White sourdough",
    situation: "Sells out by ~11am every Saturday — steady walk-aways all afternoon.",
    move: "Lift the Saturday send 20 → 28.", gain: 9, conf: "high" },
  { id: "o5", lever: "waste", store: "Woolworths Woden", region: "Canberra / ACT", product: "Wholemeal sourdough",
    situation: "62% waste on the mid-week drop — consistently more than the shelf turns over.",
    move: "Trim the Tuesday & Wednesday sends to the shelf's real pace.", gain: 8, conf: "high" },
  { id: "o6", lever: "rebalance", store: "Harris Farm Mosman", region: "North Shore", product: "Challah range",
    situation: "Challah is spread evenly across the week, but demand is almost all Friday (Shabbat).",
    move: "Shift mid-week challah into the Friday bake — more captured, less binned.", gain: 6, conf: "high" },
  { id: "o7", lever: "range", store: "Woolworths Mascot", region: "South East", product: "Spelt sourdough",
    situation: "Premium line missing where the demographic and neighbouring stores support it.",
    move: "Range spelt sourdough — seed 6/wk.", gain: 5, conf: "medium" },
];

export default function OpportunityFinder() {
  const [queued, setQueued] = useState<Record<string, boolean>>({});
  const ranked = useMemo(() => [...OPPS].sort((a, b) => b.gain - a.gain), []);

  const total = OPPS.reduce((a, o) => a + o.gain, 0);
  const byLever = (l: Lever) => OPPS.filter((o) => o.lever === l).reduce((a, o) => a + o.gain, 0);
  const queuedUnits = OPPS.filter((o) => queued[o.id]).reduce((a, o) => a + o.gain, 0);
  const queuedCount = Object.values(queued).filter(Boolean).length;

  function toggle(id: string) { setQueued((q) => ({ ...q, [id]: !q[id] })); }

  const levers: Lever[] = ["demand", "waste", "range"];

  return (
    <div className="opps">
      <div className="panel intro">
        <div className="itxt">
          One ranked list of the biggest wins across the network — three levers pulled together: <b>capture demand</b> where
          we sell out, <b>trim waste</b> where we over-send, and <b>add range</b> where a store is missing an obvious line.
          Ranked by units at stake today; it weights by <b>revenue</b> once the price feed lands, and answers
          &ldquo;where&apos;s another $20k a month?&rdquo; in true <b>profit</b> once Simona&apos;s production cost is in.
        </div>
      </div>

      {/* Headline */}
      <div className="headline">
        <div className="hl-l">
          <div className="hl-lbl">Money on the table · this week</div>
          <div className="hl-big">~{total}<span className="u"> units/wk</span></div>
          <div className="hl-sub">across {OPPS.length} moves · <span className="dollar">revenue weighting lights up with the price feed</span></div>
        </div>
        <div className="hl-levers">
          {levers.map((l) => (
            <div className="lv" key={l}>
              <div className="lv-n" style={{ color: LEVER_META[l].c }}>{byLever(l)}<small> u/wk</small></div>
              <div className="lv-l">{LEVER_META[l].label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Ranked list */}
      <div className="bulk">
        <div className="section-h"><span className="tick" />Ranked by impact</div>
        {queuedCount > 0 && (
          <div className="queuebar">
            <span>{queuedCount} queued · ~{queuedUnits} units/wk</span>
            <button className="addplan">Add to this week&apos;s plan</button>
          </div>
        )}
      </div>

      <div className="list">
        {ranked.map((o, i) => {
          const m = LEVER_META[o.lever];
          const q = !!queued[o.id];
          return (
            <div className={`opp${q ? " q" : ""}`} key={o.id}>
              <div className="rank">{i + 1}</div>
              <div className="obody">
                <div className="o-top">
                  <span className="o-chip" style={{ background: m.b, color: m.c }}>{m.label}</span>
                  <span className="o-store">{o.store}</span>
                  <span className="o-dot">·</span>
                  <span className="o-prod">{o.product}</span>
                  <span className="o-region">{o.region}</span>
                  <span className="o-gain">+{o.gain}<small> u/wk</small></span>
                </div>
                <div className="o-sit">{o.situation}</div>
                <div className="o-move"><span className="mv-lbl">{m.verb}</span>{o.move}</div>
              </div>
              <div className="oact">
                <span className={`conf ${o.conf}`}>{o.conf === "high" ? "High confidence" : "Worth a look"}</span>
                <button className={`qbtn${q ? " on" : ""}`} onClick={() => toggle(o.id)}>
                  {q ? "✓ Queued" : "Queue move"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="foot" style={{ marginTop: 16 }}>
        Representative of what the engine surfaces from waste, sell-through and ranging gaps. Ranked by units today; it
        re-orders by revenue when the price feed lands (Invoice_Cost, per Fred), and by true profit once Simona&apos;s
        production cost per unit is in — that&apos;s the version that answers the dollar question directly.
      </div>

      <style>{`
        .opps .intro{margin-bottom:16px}
        .opps .intro .itxt{font-size:14.5px;line-height:1.65;color:var(--ink2)}
        .opps .intro b{color:var(--ink);font-weight:600}
        .opps .headline{background:var(--espresso);border-radius:var(--r);padding:20px 24px;margin-bottom:18px;display:flex;align-items:center;gap:28px;flex-wrap:wrap;color:#f3e9d6}
        .opps .hl-lbl{font-size:11px;letter-spacing:1.2px;text-transform:uppercase;color:#c7b596;font-weight:700}
        .opps .hl-big{font-family:var(--serif);font-size:40px;font-weight:600;line-height:1;letter-spacing:-1px;font-variant-numeric:tabular-nums;margin-top:8px;color:#fff}
        .opps .hl-big .u{font-size:16px;color:#c7b596;font-family:var(--sans);font-weight:500}
        .opps .hl-sub{font-size:12.5px;color:#c7b596;margin-top:8px}
        .opps .hl-sub .dollar{color:#e6d3ab}
        .opps .hl-levers{margin-left:auto;display:flex;gap:14px}
        .opps .lv{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:12px 16px;min-width:104px}
        .opps .lv-n{font-family:var(--serif);font-size:26px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums}
        .opps .lv-n small{font-size:12px;color:#b7a588;font-family:var(--sans);font-weight:500}
        .opps .lv-l{font-size:12px;color:#c7b596;margin-top:6px}

        .opps .bulk{display:flex;align-items:center;gap:14px;margin-bottom:12px}
        .opps .queuebar{margin-left:auto;display:flex;align-items:center;gap:12px;font-size:13px;font-weight:600;color:var(--ink2)}
        .opps .addplan{background:var(--green);border:1px solid var(--green);color:#fff;border-radius:10px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
        .opps .addplan:hover{background:#548050}

        .opps .list{display:flex;flex-direction:column;gap:12px}
        .opps .opp{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px;display:flex;gap:16px;align-items:flex-start;transition:box-shadow .15s}
        .opps .opp:hover{box-shadow:var(--sh-pop)}
        .opps .opp.q{border-color:var(--green);box-shadow:0 0 0 1px var(--green)}
        .opps .rank{width:30px;height:30px;flex:none;border-radius:9px;background:var(--surface);border:1px solid var(--line);font-family:var(--serif);font-weight:600;font-size:15px;display:flex;align-items:center;justify-content:center;color:var(--ink2);font-variant-numeric:tabular-nums}
        .opps .obody{flex:1;min-width:0}
        .opps .o-top{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:7px}
        .opps .o-chip{font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap}
        .opps .o-store{font-family:var(--serif);font-weight:600;font-size:15.5px}
        .opps .o-dot{color:var(--faint)}
        .opps .o-prod{font-size:13.5px;color:var(--ink2);font-weight:600}
        .opps .o-region{font-size:12px;color:var(--muted)}
        .opps .o-gain{margin-left:auto;font-size:16px;font-weight:700;color:var(--green-t);font-variant-numeric:tabular-nums;white-space:nowrap}
        .opps .o-gain small{font-size:11px;color:var(--muted);font-weight:600}
        .opps .o-sit{font-size:13.5px;color:var(--ink2);line-height:1.55;margin-bottom:9px}
        .opps .o-move{font-size:13.5px;color:var(--ink);background:var(--surface);border:1px solid var(--line2);border-radius:9px;border-left:2px solid var(--crust);padding:9px 12px;line-height:1.5}
        .opps .mv-lbl{font-size:10px;letter-spacing:.8px;text-transform:uppercase;color:var(--crust-deep);font-weight:700;display:inline-block;margin-right:8px}
        .opps .oact{display:flex;flex-direction:column;align-items:flex-end;gap:9px;flex:none;width:132px}
        .opps .conf{font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:999px;white-space:nowrap}
        .opps .conf.high{background:var(--green-b);color:var(--green-t)}
        .opps .conf.medium{background:var(--amber-b);color:var(--amber-t)}
        .opps .qbtn{border:1px solid var(--line);background:var(--card);border-radius:var(--rc);padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;color:var(--ink);white-space:nowrap}
        .opps .qbtn:hover{background:#f6f0e6}
        .opps .qbtn.on{background:var(--green);border-color:var(--green);color:#fff}

        @media (max-width:1080px){ .opps .headline{gap:16px} .opps .hl-levers{margin-left:0} .opps .oact{width:auto;flex-direction:row;align-items:center} }
      `}</style>
    </div>
  );
}
