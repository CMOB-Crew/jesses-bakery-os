"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { ForecastAccuracyData, FaccStore } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Forecast accuracy — is the plan actually getting it right? With no
 * stored engine forecasts to grade yet, this is a real backtest: for
 * every store and product we replay the honest baseline the plan has
 * to beat — a trailing-demand forecast (each week from the mean of the
 * prior weeks) — and score it against what actually sold. One metric
 * everywhere: "closeness" (100 = spot on). Over-forecast leans to
 * waste; under-forecast leans to stockouts, so the same number that
 * grades the plan points to which of the other two problems a store
 * has. Every scored (store, week) pair is one real snapshot; the count
 * is shown, not asserted.
 * ------------------------------------------------------------------ */

function accClass(a: number) { return a >= 85 ? "green" : a >= 78 ? "amber" : "red"; }

// Smooth line path (Catmull-Rom -> bezier), matching the waste chart idiom.
function smoothPath(pts: [number, number][], t = 0.16) {
  if (pts.length < 3) return pts.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join(" ");
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
    const c1x = p1[0] + (p2[0] - p0[0]) * t, c1y = p1[1] + (p2[1] - p0[1]) * t;
    const c2x = p2[0] - (p3[0] - p1[0]) * t, c2y = p2[1] - (p3[1] - p1[1]) * t;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
  }
  return d;
}

function Spark({ vals }: { vals: number[] }) {
  const W = 66, H = 22, pad = 2;
  if (vals.length < 2) return <span style={{ fontSize: 11, color: "var(--muted)" }}>—</span>;
  const max = Math.max(...vals), min = Math.min(...vals), rng = max - min || 1;
  const xs = (i: number) => pad + (i * (W - pad * 2)) / (vals.length - 1);
  const ys = (v: number) => pad + (1 - (v - min) / rng) * (H - pad * 2);
  const pts = vals.map((v, i) => [xs(i), ys(v)] as [number, number]);
  const up = vals[vals.length - 1] >= vals[0];
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block" }}>
      <polyline points={pts.map((p) => p.join(",")).join(" ")} fill="none"
        stroke={up ? "var(--green)" : "var(--red)"} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2" fill={up ? "var(--green)" : "var(--red)"} />
    </svg>
  );
}

const TABLE_CAP = 14;

export default function ForecastAccuracy({ data }: { data: ForecastAccuracyData | null }) {
  const [showAll, setShowAll] = useState(false);

  // Worst-first for the table — surface the stores needing model attention.
  const ranked = useMemo<FaccStore[]>(
    () => (data ? [...data.stores].sort((a, b) => a.acc - b.acc) : []),
    [data]
  );

  if (!data || data.weeks.length < 2) {
    return (
      <div className="facc">
        <div className="panel intro">
          <div className="itxt">
            The honest scoreboard: every forecast checked against what actually sold, so you can see whether the plan is
            getting it right. This page is <b>built and ready</b> — it fills in the moment your full sales history is
            loaded. Right now there&apos;s only today&apos;s snapshot to work from, so there&apos;s nothing to score yet;
            with a few weeks of history behind it, the network trend, per-store accuracy and per-product difficulty all
            appear here on their own.
          </div>
        </div>
        <div className="strip">
          <div className="tile"><div className="tn dim">—</div><div className="tl">Network accuracy · mean closeness to actual (100 = spot on)</div></div>
          <div className="tile"><div className="tn dim">—</div><div className="tl">Bias · over-send (waste) vs under-send (selling out)</div></div>
          <div className="tile"><div className="tn dim">—</div><div className="tl">Change vs prior weeks</div></div>
          <div className="tile"><div className="tn dim">—</div><div className="tl">Stores at or above the 85% target</div></div>
        </div>
        <div className="emptyhint">Waiting on data, not on more building — the scoreboard switches on the moment your historical sales are loaded.</div>
        <style>{faccCss}</style>
      </div>
    );
  }

  const { weeks, network, improve, improveWindow, netBias, onTrack, target, lookback, snapshots, panelStores, panelBalanced } = data;
  const shown = showAll ? ranked : ranked.slice(0, TABLE_CAP);
  const hasProducts = data.hard.length > 0 && data.easy.length > 0;

  // Trend chart geometry — y-range adapts to the real data.
  const W = 720, H = 210, pL = 34, pR = 14, pT = 16, pB = 30;
  const lo = Math.min(target, ...weeks), hi = Math.max(target, ...weeks);
  const yMin = Math.max(0, Math.floor((lo - 4) / 5) * 5);
  const yMax = Math.min(100, Math.ceil((hi + 4) / 5) * 5);
  const xs = (i: number) => pL + (i * (W - pL - pR)) / (weeks.length - 1);
  const ys = (v: number) => pT + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - pT - pB);
  const pts = weeks.map((v, i) => [xs(i), ys(v)] as [number, number]);
  const line = smoothPath(pts);
  const area = `${line} L ${xs(weeks.length - 1).toFixed(1)} ${H - pB} L ${pL} ${H - pB} Z`;
  const gridY: number[] = [];
  for (let g = yMin; g <= yMax; g += 5) gridY.push(g);

  return (
    <div className="facc">
      <div className="panel intro">
        <div className="itxt">
          Every forecast is scored against what the store actually sold. With no saved forecasts to grade yet,
          this backtests the honest baseline the plan has to beat — a <b>trailing-demand forecast</b> replayed across
          the real sales history. <b>Over-forecasting leans to waste; under-forecasting leans to selling out</b> — so the
          same number that grades the forecast points to which of the other two problems a store has.
        </div>
      </div>

      {/* Strip */}
      <div className="strip">
        <div className="tile">
          <div className="tn">{network}<span className="u">%</span></div>
          <div className="tl">Network accuracy · mean closeness to actual (100 = spot on)</div>
        </div>
        <div className="tile">
          <div className={`tn ${netBias > 0 ? "amber" : "blue"}`}>{netBias > 0 ? "+" : ""}{netBias}<span className="u">%</span></div>
          <div className="tl">Bias · {netBias > 0 ? "leans over → waste" : netBias < 0 ? "leans under → selling out" : "balanced"}</div>
        </div>
        <div className="tile">
          <div className={`tn ${improve >= 0 ? "green" : "red"}`}>{improve >= 0 ? "+" : ""}{improve}<span className="u"> pts</span></div>
          <div className="tl">Change vs {weeks.length >= 5 ? "4 weeks ago" : "start of window"}</div>
        </div>
        <div className="tile">
          <div className="tn">{onTrack}<span className="u">%</span></div>
          <div className="tl">Stores at or above the {target}% target</div>
        </div>
      </div>

      {/* Trend chart */}
      <div className="chartcard">
        <div className="cc-top">
          <div>
            <div className="cc-lbl">Forecast accuracy · last {weeks.length} weeks</div>
            <div className="cc-big">{network}<span className="u">%</span></div>
            <div className={`cc-sub ${improveWindow >= 0 ? "good" : "bad"}`}>
              {improveWindow >= 0 ? "↑" : "↓"} {Math.abs(improveWindow)} points across the window
            </div>
            <div className="cc-panel">
              {panelBalanced
                ? `Same ${panelStores} stores at every point — the line moves because the forecast moved, not because a different set of stores reported.`
                : "Too few stores report in every week of this window for a like-for-like line, so each point is whoever reported that week. Read the shape with that in mind."}
            </div>
          </div>
          <div className="cc-legend"><span className="dash" /> {target}% target</div>
        </div>
        <svg className="trend" viewBox={`0 0 ${W} ${H}`} width="100%">
          <defs>
            <linearGradient id="faccFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--crust)" stopOpacity="0.20" />
              <stop offset="1" stopColor="var(--crust)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {gridY.map((g) => (
            <g key={g}>
              <line x1={pL} y1={ys(g)} x2={W - pR} y2={ys(g)} stroke="var(--line2)" strokeWidth="1" />
              <text x={8} y={ys(g) + 4} fontSize="11" fill="var(--muted)">{g}</text>
            </g>
          ))}
          <line x1={pL} y1={ys(target)} x2={W - pR} y2={ys(target)} stroke="var(--crust)" strokeWidth="1.3" strokeDasharray="4 4" opacity="0.7" />
          <path d={area} fill="url(#faccFill)" />
          <path d={line} fill="none" stroke="var(--crust)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={i === pts.length - 1 ? 4 : 2.5} fill="var(--crust)" />)}
          {weeks.map((_, i) => (
            <text key={i} x={xs(i)} y={H - 10} fontSize="10.5" fill="var(--muted)" textAnchor="middle">
              {i === weeks.length - 1 ? "now" : "w" + (i + 1)}
            </text>
          ))}
        </svg>
      </div>

      {/* Per-store table */}
      <div className="section-h" style={{ marginTop: 22, marginBottom: 10 }}>
        <span className="tick" />Accuracy by store
        <span className="cnt">{ranked.length} stores scored on their sales history · lowest first</span>
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr><th>Store</th><th className="num">Accuracy</th><th>Bias</th><th>Recent trend</th><th className="num">Flag</th></tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.store_id}>
                <td><Link prefetch={false} href={`/store/${s.store_id}`} className="stn">{s.store}</Link><div className="str">{s.region ?? "—"}</div></td>
                <td className="num"><span className={`accpill ${accClass(s.acc)}`}>{s.acc}%</span></td>
                <td>
                  <span className={`bias ${s.bias > 0 ? "over" : "under"}`}>
                    {s.bias > 0 ? "+" : ""}{s.bias}% {s.bias > 0 ? "over → waste" : s.bias < 0 ? "under → selling out" : "balanced"}
                  </span>
                </td>
                <td><Spark vals={s.trend} /></td>
                <td className="num">{s.acc < 78 ? <span className="tag red">Model attention</span> : s.acc < 85 ? <span className="tag amber">Watch</span> : <span className="tag green">On track</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {ranked.length > TABLE_CAP && (
        <button className="morebtn" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show all ${ranked.length} stores`}
        </button>
      )}

      {/* Product accuracy */}
      {hasProducts && (
        <div className="prodgrid">
          <div>
            <div className="section-h" style={{ marginTop: 22, marginBottom: 10 }}><span className="tick" />Hardest to forecast</div>
            <div className="panel" style={{ padding: 0 }}>
              {data.hard.map((p, i) => (
                <div className="prow" key={p.name} style={{ borderTop: i ? "1px solid var(--line2)" : undefined }}>
                  <div className="pn">{p.name}<span className={`accpill ${accClass(p.acc)}`}>{p.acc}%</span></div>
                  <div className="pw">{p.why}</div>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="section-h" style={{ marginTop: 22, marginBottom: 10 }}><span className="tick" />Most reliable</div>
            <div className="panel" style={{ padding: 0 }}>
              {data.easy.map((p, i) => (
                <div className="prow" key={p.name} style={{ borderTop: i ? "1px solid var(--line2)" : undefined }}>
                  <div className="pn">{p.name}<span className={`accpill ${accClass(p.acc)}`}>{p.acc}%</span></div>
                  <div className="pw">{p.why}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="foot" style={{ marginTop: 16 }}>
        Real backtest over {snapshots.toLocaleString()} scored store-week snapshots. Each week is forecast from the mean
        of the prior {lookback} weeks and scored against actual sales; the current (partial) week is held out. This is
        the baseline the plan must beat — once the plan writes its own forecasts, they score in right here alongside it.
      </div>

      <style>{faccCss}</style>
    </div>
  );
}

const faccCss = `
  .facc .intro{margin-bottom:16px}
  .facc .intro .itxt{font-size:14.5px;line-height:1.65;color:var(--ink2)}
  .facc .intro b{color:var(--ink);font-weight:600}
  .facc .strip{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}
  .facc .tile{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px}
  .facc .tn{font-family:var(--serif);font-size:32px;font-weight:600;line-height:1;letter-spacing:-.6px;font-variant-numeric:tabular-nums}
  .facc .tn .u{font-size:15px;color:var(--muted);font-family:var(--sans);font-weight:500}
  .facc .tn.green{color:var(--green-t)} .facc .tn.amber{color:var(--amber-t)} .facc .tn.red{color:var(--red-t)} .facc .tn.blue{color:#4f7396}
  .facc .tn.dim{color:var(--muted)}
  .facc .tl{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.4}
  .facc .emptyhint{font-size:13px;color:var(--faint);line-height:1.6}

  .facc .chartcard .cc-top{display:flex;justify-content:space-between;align-items:flex-start}
  .facc .cc-lbl{font-size:12px;color:var(--muted)}
  .facc .cc-big{font-family:var(--serif);font-size:38px;font-weight:600;line-height:1;letter-spacing:-1px;font-variant-numeric:tabular-nums;margin-top:6px}
  .facc .cc-big .u{font-size:.5em;color:var(--muted);font-weight:500}
  .facc .cc-sub{font-size:12.5px;margin-top:6px;font-weight:600}
  .facc .cc-panel{font-size:11.5px;color:var(--muted);margin-top:6px;line-height:1.5;max-width:520px}
  .facc .cc-sub.good{color:var(--green-t)} .facc .cc-sub.bad{color:var(--red-t)}
  .facc .cc-legend{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:7px}
  .facc .cc-legend .dash{width:16px;height:0;border-top:1.5px dashed var(--crust);display:inline-block}
  .facc .trend{margin-top:6px;overflow:visible}

  .facc .section-h .cnt{margin-left:auto;font-size:11.5px;font-weight:500;color:var(--muted)}
  .facc .stn{display:block;font-weight:600;font-size:13.5px;color:inherit;text-decoration:none;cursor:pointer}
  .facc .stn:hover{text-decoration:underline}
  .facc .str{font-size:11.5px;color:var(--muted);margin-top:2px}
  .facc .accpill{display:inline-block;font-weight:700;font-size:12.5px;padding:3px 9px;border-radius:999px;font-variant-numeric:tabular-nums}
  .facc .accpill.green{background:var(--green-b);color:var(--green-t)}
  .facc .accpill.amber{background:var(--amber-b);color:var(--amber-t)}
  .facc .accpill.red{background:var(--red-b);color:var(--red-t)}
  .facc .bias{font-size:12.5px;font-weight:600}
  .facc .bias.over{color:var(--amber-t)} .facc .bias.under{color:#4f7396}

  .facc .morebtn{margin-top:12px;border:1px solid var(--line);background:var(--card);color:var(--ink2);
    border-radius:var(--rc);padding:8px 15px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
  .facc .morebtn:hover{background:#f6f0e6}

  .facc .prodgrid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .facc .prow{padding:13px 16px}
  .facc .pn{display:flex;align-items:center;gap:10px;font-family:var(--serif);font-size:14.5px;font-weight:600}
  .facc .pn .accpill{margin-left:auto}
  .facc .pw{font-size:12.5px;color:var(--muted);margin-top:5px;line-height:1.5}

  @media (max-width:1080px){ .facc .strip{grid-template-columns:1fr 1fr} .facc .prodgrid{grid-template-columns:1fr} }
`;
