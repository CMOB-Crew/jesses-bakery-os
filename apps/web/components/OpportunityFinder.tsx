"use client";
import { useRef, useState } from "react";
import type { Opportunities, OppLever } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Opportunity finder — one ranked "where's the next dollar" list, live
 * from real data: trim waste (over-delivering stores, sized from the
 * plan where present) and capture demand (stores with stockout days).
 * Simona's "where can we make another $20k a month?". Ranked by units
 * today; re-sorts by revenue once the price feed lands, and by true
 * profit once Simona's production cost is in. Range/rebalance surface as
 * per-product data builds — not faked here.
 * ------------------------------------------------------------------ */

const LEVER_META: Record<OppLever, { label: string; verb: string; c: string; b: string }> = {
  demand:    { label: "Capture demand", verb: "Capture", c: "var(--green-t)", b: "var(--green-b)" },
  waste:     { label: "Trim waste",     verb: "Trim",    c: "var(--crust-deep)", b: "rgba(176,116,28,.13)" },
  range:     { label: "Add range",      verb: "Range",   c: "#4f7396", b: "rgba(79,115,150,.13)" },
  rebalance: { label: "Rebalance",      verb: "Shift",   c: "#8a5aa0", b: "rgba(138,90,160,.13)" },
};

export default function OpportunityFinder({ data }: { data: Opportunities }) {
  const [queued, setQueued] = useState<Record<string, boolean>>({});
  const queuedCount = Object.values(queued).filter(Boolean).length;
  const queuedUnits = data.opps.filter((o) => queued[o.id]).reduce((a, o) => a + o.gain, 0);
  function toggle(id: string) { setQueued((q) => ({ ...q, [id]: !q[id] })); }

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3400);
  }

  if (!data.hasData) {
    return (
      <div className="opps">
        <div className="panel intro">
          <div className="itxt">
            One ranked list of the biggest wins across the network — trim waste where we over-send, capture demand where
            we sell out. This fills in as the ledger accumulates weeks: over-delivery shows up first on the fuller
            Woolworths feed, sell-outs as the on-hand ledger builds. Nothing to action yet.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="opps">
      <div className="panel intro">
        <div className="itxt">
          One ranked list of the biggest wins across the network — <b>trim waste</b> where we over-send and
          <b> capture demand</b> where we sell out, straight from this week&apos;s numbers. Ranked by units at stake today;
          it weights by <b>revenue</b> once the price feed lands, and answers &ldquo;where&apos;s another $20k a month?&rdquo;
          in true <b>profit</b> once Simona&apos;s production cost is in.
        </div>
      </div>

      <div className="headline">
        <div className="hl-l">
          <div className="hl-lbl">Money on the table · this week</div>
          <div className="hl-big">~{data.total}<span className="u"> units/wk</span></div>
          <div className="hl-sub">across {data.opps.length} moves · <span className="dollar">revenue weighting lights up with the price feed</span></div>
        </div>
        <div className="hl-levers">
          <div className="lv"><div className="lv-n" style={{ color: LEVER_META.demand.c }}>{data.demandUnits}<small> u/wk</small></div><div className="lv-l">Capture demand</div></div>
          <div className="lv"><div className="lv-n" style={{ color: LEVER_META.waste.c }}>{data.wasteUnits}<small> u/wk</small></div><div className="lv-l">Trim waste</div></div>
          <div className="lv"><div className="lv-n" style={{ color: "#c7b596" }}>·</div><div className="lv-l">Range &amp; rebalance as product data builds</div></div>
        </div>
      </div>

      <div className="bulk">
        <div className="section-h"><span className="tick" />Ranked by impact</div>
        {queuedCount > 0 && (
          <div className="queuebar">
            <span>{queuedCount} queued · ~{queuedUnits} units/wk</span>
            <button
              className="addplan"
              onClick={() => showToast(`Queued ${queuedCount} move${queuedCount === 1 ? "" : "s"} (~${queuedUnits} units/wk) — writing them into this week's plan is the next build phase`)}
            >
              Add to this week&apos;s plan
            </button>
          </div>
        )}
      </div>

      <div className="list">
        {data.opps.map((o, i) => {
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
        Live from the store-week view and the plan. Trim-waste moves are sized from the plan where a store has one,
        else right-sized to demand. Ranked by units today; it re-orders by revenue when the price feed lands (Invoice_Cost),
        and by true profit once Simona&apos;s production cost per unit is in.
      </div>

      {toast && <div className="toast">{toast}</div>}

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
        .opps .lv{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:12px 16px;min-width:104px;max-width:150px}
        .opps .lv-n{font-family:var(--serif);font-size:26px;font-weight:600;line-height:1;font-variant-numeric:tabular-nums}
        .opps .lv-n small{font-size:12px;color:#b7a588;font-family:var(--sans);font-weight:500}
        .opps .lv-l{font-size:12px;color:#c7b596;margin-top:6px;line-height:1.35}

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

        .opps .toast{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);background:var(--espresso);color:#f6eddb;padding:12px 18px;border-radius:12px;box-shadow:var(--sh-pop);font-size:13.5px;font-weight:500;z-index:60;max-width:88vw;text-align:center}
        @media (max-width:1080px){ .opps .headline{gap:16px} .opps .hl-levers{margin-left:0} .opps .oact{width:auto;flex-direction:row;align-items:center} }
      `}</style>
    </div>
  );
}
