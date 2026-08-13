"use client";

import { useState } from "react";
import type { EngineScenario } from "@/lib/queries";

const nf = (n: number) => n.toLocaleString("en-AU");

// The hero of the whole build: "waste this week — today vs. the plan", on the
// real Woolworths ledger. Before→after on the left with the cut line + legend;
// the service dial and its four numbers on the right. The dial trades waste
// against lost sales — every setting sits below today's rate. $ unlocks with
// the per-unit cost data already in the retailer feeds.
export default function EnginePanel({ scenarios }: { scenarios: EngineScenario[] }) {
  const current = scenarios.find((s) => s.scenario === "current");
  const engines = scenarios.filter((s) => s.scenario !== "current").sort((a, b) => a.ord - b.ord);
  const [sel, setSel] = useState("balanced");

  if (!current || engines.length === 0) return null;

  const eng = engines.find((e) => e.scenario === sel) ?? engines.find((e) => e.scenario === "balanced") ?? engines[0];
  const curPct = Number(current.waste_pct) || 0;
  const engPct = Number(eng.waste_pct) || 0;
  const drop = Math.round((curPct - engPct) * 10) / 10;
  const savedWk = Number(eng.units_saved_wk) || 0;
  const annual = savedWk * 52;
  const lost = eng.lost_sales_pct == null ? null : Number(eng.lost_sales_pct);
  const planWidth = curPct > 0 ? Math.min(100, (engPct / curPct) * 100) : 100;

  return (
    <div className="enghero">
      <div className="engine">
        <div className="eng-top">
          <span className="dot" />
          <h2>Waste this week — today vs. the plan</h2>
          <span className="src">Woolworths feed · this week · real delivered vs sold</span>
        </div>

        <div className="eng-grid">
          <div>
            <div className="ba">
              <div className="cell now">
                <div className="k">Their system today</div>
                <div className="big">{curPct}<span className="u">%</span></div>
              </div>
              <div className="arrow"><svg viewBox="0 0 34 20"><path d="M2 10h28M22 3l8 7-8 7" /></svg></div>
              <div className="cell aft">
                <div className="k">With the plan · {eng.label.split(" ")[0].toLowerCase()}</div>
                <div className="big">{engPct}<span className="u">%</span></div>
              </div>
            </div>
            <div className="cut">▼ {drop} points less waste — ~{nf(savedWk)} loaves saved a week</div>
            <div className="baleg">
              <div className="track">
                <i style={{ width: "100%", background: "var(--red-b)" }} />
                <i style={{ width: `${planWidth}%`, background: "var(--green)" }} />
              </div>
              <div className="row"><span className="lab">Today</span><span>{curPct}% wasted</span><span className="v" /></div>
              <div className="row"><span className="lab">The plan</span><span>{engPct}% wasted</span><span className="v">−{nf(savedWk)}</span></div>
            </div>
          </div>

          <div className="dialwrap">
            <div className="dialhd"><span className="t">Service dial</span><span className="hint">trades waste vs. selling out</span></div>
            <div className="seg">
              {engines.map((e) => (
                <button key={e.scenario} type="button" className={e.scenario === sel ? "on" : ""} onClick={() => setSel(e.scenario)}>
                  {e.label.split(" ")[0]}
                  {e.scenario === "balanced" && <small>default</small>}
                </button>
              ))}
            </div>
            <div className="quad">
              <div className="q"><div className="qn">{nf(savedWk)}</div><div className="ql">loaves saved / week</div></div>
              <div className="q"><div className="qn">~{nf(annual)}</div><div className="ql">saved / year</div></div>
              <div className="q"><div className="qn">{lost ?? "—"}<span className="us">%</span></div><div className="ql">lost-sales trade-off</div></div>
              <div className="q"><div className="qn">{engPct}<span className="us">%</span></div><div className="ql">waste at this setting</div></div>
            </div>
          </div>
        </div>

        <div className="eng-foot">
          Mature Woolworths feed only (Coles &amp; Harris held until their feeds fill).
          Dollar figures come next — the per-unit cost data already lives in your retailer feeds.
        </div>
      </div>

      <style>{`
      .enghero .engine{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:26px 28px;margin:22px 0 24px}
      .enghero .eng-top{display:flex;align-items:center;gap:10px;margin-bottom:22px;flex-wrap:wrap}
      .enghero .eng-top .dot{width:10px;height:10px;border-radius:3px;background:var(--amber)}
      .enghero .eng-top h2{font-family:var(--serif);font-size:19px;font-weight:600;letter-spacing:-.2px}
      .enghero .eng-top .src{margin-left:auto;font-size:11.5px;color:var(--faint)}
      .enghero .eng-grid{display:grid;grid-template-columns:1.15fr 1fr;gap:34px;align-items:center}
      @media(max-width:900px){.enghero .eng-grid{grid-template-columns:1fr;gap:24px}}
      .enghero .ba{display:flex;align-items:center;gap:22px;flex-wrap:wrap}
      .enghero .ba .cell .k{font-size:10.5px;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);font-weight:700;margin-bottom:7px}
      .enghero .ba .big{font-family:var(--serif);font-size:52px;font-weight:600;line-height:.9;letter-spacing:-1.5px;font-variant-numeric:tabular-nums}
      .enghero .ba .big .u{font-size:.4em;color:var(--muted);font-weight:500}
      .enghero .ba .now .big{color:var(--red)}
      .enghero .ba .aft .big{color:var(--green-t)}
      .enghero .ba .arrow{color:var(--faint);display:flex;flex-direction:column;align-items:center;gap:4px;font-size:11px}
      .enghero .ba .arrow svg{width:34px;height:20px;stroke:var(--crust);stroke-width:2;fill:none}
      .enghero .cut{margin-top:16px;display:inline-flex;align-items:center;gap:9px;background:var(--amber-b);color:var(--amber-t);border-radius:999px;padding:7px 14px;font-weight:700;font-size:13px}
      .enghero .baleg{margin-top:16px}
      .enghero .baleg .track{height:11px;border-radius:6px;background:#efe7d6;overflow:hidden;position:relative}
      .enghero .baleg .track i{position:absolute;left:0;top:0;bottom:0;border-radius:6px}
      .enghero .baleg .row{display:flex;align-items:center;gap:10px;margin-top:8px;font-size:11.5px;color:var(--muted)}
      .enghero .baleg .row .lab{width:96px;text-align:right;flex:none}
      .enghero .baleg .row .v{margin-left:auto;font-weight:700;color:var(--ink2);font-variant-numeric:tabular-nums}
      .enghero .dialwrap{background:var(--surface);border:1px solid var(--line2);border-radius:12px;padding:18px}
      .enghero .dialhd{display:flex;align-items:center;justify-content:space-between;margin-bottom:11px;gap:8px;flex-wrap:wrap}
      .enghero .dialhd .t{font-size:11px;letter-spacing:.7px;text-transform:uppercase;color:var(--muted);font-weight:700}
      .enghero .dialhd .hint{font-size:11px;color:var(--faint)}
      .enghero .seg{display:flex;background:#ece3d1;border-radius:10px;padding:3px;gap:3px}
      .enghero .seg button{flex:1;border:none;background:transparent;font-family:inherit;font-size:13px;font-weight:600;color:var(--muted);padding:9px 6px;border-radius:8px;cursor:pointer;transition:.15s;letter-spacing:-.1px}
      .enghero .seg button:hover{color:var(--ink2)}
      .enghero .seg button.on{background:var(--card);color:var(--ink);box-shadow:0 1px 3px rgba(60,45,30,.16)}
      .enghero .seg button small{display:block;font-size:10px;font-weight:600;color:var(--muted);letter-spacing:0;margin-top:1px}
      .enghero .seg button.on small{color:var(--green-t)}
      .enghero .quad{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--line2);border:1px solid var(--line2);border-radius:12px;overflow:hidden;margin-top:14px}
      .enghero .quad .q{background:var(--card);padding:14px 16px}
      .enghero .quad .q .qn{font-family:var(--serif);font-size:24px;font-weight:600;letter-spacing:-.5px;font-variant-numeric:tabular-nums;line-height:1}
      .enghero .quad .q .qn .us{font-size:15px;color:var(--muted);font-weight:500}
      .enghero .quad .q .ql{font-size:11px;color:var(--muted);margin-top:6px}
      .enghero .eng-foot{margin-top:20px;padding-top:16px;border-top:1px solid var(--line2);font-size:11.5px;color:var(--faint);line-height:1.6}
      `}</style>
    </div>
  );
}
