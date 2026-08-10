"use client";

import { useState } from "react";
import type { EngineScenario } from "@/lib/queries";

// The hero of the whole build: "waste today vs. with the engine", on real
// Woolworths ledger data. The service dial trades waste against lost sales —
// every setting sits below the current 32.5%. $ figure unlocks with cost data.
export default function EnginePanel({ scenarios }: { scenarios: EngineScenario[] }) {
  const current = scenarios.find((s) => s.scenario === "current");
  const engines = scenarios
    .filter((s) => s.scenario !== "current")
    .sort((a, b) => a.ord - b.ord);
  const [sel, setSel] = useState("balanced");

  if (!current || engines.length === 0) return null;

  const eng = engines.find((e) => e.scenario === sel) ?? engines[1] ?? engines[0];
  const curPct = current.waste_pct ?? 0;
  const engPct = eng.waste_pct ?? 0;
  const drop = Math.round((curPct - engPct) * 10) / 10;
  const annual = (eng.units_saved_wk * 52).toLocaleString("en-AU");
  const savedWk = eng.units_saved_wk.toLocaleString("en-AU");

  return (
    <div className="engine">
      <div className="eng-top">
        <div className="eng-title">
          <span className="tick" />
          Waste today vs. with the engine
        </div>
        <div className="eng-src">Woolworths feed · this week · real delivered vs sold</div>
      </div>

      <div className="eng-body">
        <div className="eng-headline">
          <div className="eng-from">
            <div className="eng-cap">Their system today</div>
            <div className="eng-num bad">{curPct}<span className="u">%</span></div>
          </div>
          <div className="eng-arrow">→</div>
          <div className="eng-to">
            <div className="eng-cap">With the engine · {eng.label}</div>
            <div className="eng-num good">{engPct}<span className="u">%</span></div>
          </div>
          <div className="eng-drop">
            <div className="eng-dropn">−{drop} pts</div>
            <div className="eng-dropl">waste cut</div>
          </div>
        </div>

        <div className="eng-side">
          <div className="eng-dial">
            <div className="eng-diallbl">Service dial</div>
            <div className="eng-btns">
              {engines.map((e) => (
                <button
                  key={e.scenario}
                  className={`eng-btn ${e.scenario === sel ? "on" : ""}`}
                  onClick={() => setSel(e.scenario)}
                  type="button"
                >
                  {e.label.split(" ")[0]}
                </button>
              ))}
            </div>
          </div>

          <div className="eng-metrics">
            <div className="eng-metric">
              <div className="eng-mv">{savedWk}</div>
              <div className="eng-ml">loaves saved / week</div>
            </div>
            <div className="eng-metric">
              <div className="eng-mv">~{annual}</div>
              <div className="eng-ml">/ year</div>
            </div>
            <div className="eng-metric">
              <div className="eng-mv">{eng.lost_sales_pct ?? "—"}<span className="u">%</span></div>
              <div className="eng-ml">lost-sales trade-off</div>
            </div>
          </div>
        </div>
      </div>

      <div className="eng-foot">
        Mature Woolworths feed only (Coles &amp; Harris held until their feeds fill).
        Dollar value unlocks with Simona&apos;s cost-per-product sheet — then loaves become $.
      </div>

      <style>{`
        .engine {
          border: 1px solid var(--line, #23262b);
          background: linear-gradient(180deg, rgba(255,199,44,0.05), transparent 60%), var(--card, #14161a);
          border-radius: 16px;
          padding: 20px 22px;
          margin: 22px 0 6px;
        }
        .eng-top { display:flex; justify-content:space-between; align-items:baseline; gap:12px; flex-wrap:wrap; }
        .eng-title { display:flex; align-items:center; gap:9px; font-weight:650; font-size:15px; letter-spacing:.2px; }
        .eng-title .tick { width:8px; height:8px; border-radius:2px; background: var(--accent, #FFC72C); display:inline-block; }
        .eng-src { color: var(--faint, #7c828c); font-size:12.5px; }
        .eng-body { display:flex; gap:26px; align-items:center; margin-top:16px; flex-wrap:wrap; }
        .eng-headline { display:flex; align-items:center; gap:20px; flex:1 1 340px; }
        .eng-cap { color: var(--faint, #7c828c); font-size:11.5px; text-transform:uppercase; letter-spacing:.6px; margin-bottom:4px; }
        .eng-num { font-size:46px; font-weight:750; line-height:1; letter-spacing:-1px; }
        .eng-num .u { font-size:22px; font-weight:600; margin-left:1px; }
        .eng-num.bad { color: var(--red, #ff5a52); }
        .eng-num.good { color: var(--green, #35c26a); }
        .eng-arrow { font-size:26px; color: var(--faint, #7c828c); }
        .eng-drop { margin-left:6px; padding-left:18px; border-left:1px solid var(--line, #23262b); }
        .eng-dropn { color: var(--accent, #FFC72C); font-weight:750; font-size:20px; }
        .eng-dropl { color: var(--faint, #7c828c); font-size:11.5px; text-transform:uppercase; letter-spacing:.5px; }
        .eng-side { display:flex; flex-direction:column; gap:14px; flex:1 1 300px; }
        .eng-diallbl { color: var(--faint, #7c828c); font-size:11.5px; text-transform:uppercase; letter-spacing:.6px; margin-bottom:6px; }
        .eng-btns { display:inline-flex; background: var(--well, #0e1013); border:1px solid var(--line, #23262b); border-radius:10px; padding:3px; gap:2px; }
        .eng-btn { border:0; background:transparent; color: var(--dim, #b7bdc7); font-size:13px; font-weight:600; padding:7px 14px; border-radius:8px; cursor:pointer; transition:all .12s; }
        .eng-btn:hover { color:#fff; }
        .eng-btn.on { background: var(--accent, #FFC72C); color:#1a1400; }
        .eng-metrics { display:flex; gap:24px; }
        .eng-mv { font-size:21px; font-weight:700; }
        .eng-mv .u { font-size:13px; font-weight:600; }
        .eng-ml { color: var(--faint, #7c828c); font-size:12px; margin-top:2px; }
        .eng-foot { margin-top:16px; padding-top:13px; border-top:1px solid var(--line, #23262b); color: var(--faint, #7c828c); font-size:12px; line-height:1.5; }
      `}</style>
    </div>
  );
}
