"use client";

/* ------------------------------------------------------------------ *
 * Forecast accuracy — is the engine actually getting it right? Every
 * forecast is scored against what actually sold. This is how we prove
 * the waste number is really coming down (not just claimed), and how
 * the model tunes itself. Over-forecast leans to waste; under-forecast
 * leans to stockouts — so this view ties the other two together.
 *
 * Front-end prototype. Real figures come from replaying the engine's
 * forecasts vs actual sales (their own 615k historical snapshots make
 * this backtestable). Numbers here are representative.
 * ------------------------------------------------------------------ */

const WEEKS = [77, 79, 78, 81, 83, 82, 85, 86]; // % within tolerance, oldest -> newest
const TARGET = 85;

type Row = { store: string; region: string; acc: number; bias: number; trend: number[] };
const STORES: Row[] = [
  { store: "Woolworths Bondi Junction", region: "Eastern Suburbs", acc: 91, bias: 2, trend: [86, 88, 87, 89, 90, 91] },
  { store: "Coles Gladesville", region: "North Shore", acc: 90, bias: 1, trend: [85, 86, 88, 87, 89, 90] },
  { store: "Coles Ashfield", region: "Inner West", acc: 88, bias: 3, trend: [82, 84, 85, 86, 87, 88] },
  { store: "Woolworths Mascot", region: "South East", acc: 86, bias: 6, trend: [80, 81, 83, 84, 85, 86] },
  { store: "Harris Farm Mosman", region: "North Shore", acc: 84, bias: -5, trend: [83, 82, 84, 83, 85, 84] },
  { store: "Woolworths Rouse Hill", region: "North West", acc: 82, bias: 8, trend: [79, 80, 81, 80, 82, 82] },
  { store: "Woolworths Tuggeranong", region: "Canberra / ACT", acc: 74, bias: -9, trend: [70, 71, 72, 72, 73, 74] },
  { store: "Coles Belconnen", region: "Canberra / ACT", acc: 72, bias: -12, trend: [68, 69, 70, 71, 71, 72] },
];

const HARD = [
  { name: "Raisin challah", acc: 68, why: "Holiday spikes (Rosh Hashanah) swamp the weekday pattern" },
  { name: "Mini bagels", acc: 74, why: "School-holiday swings, region-dependent" },
  { name: "Sesame challah", acc: 77, why: "Shabbat Friday peak varies by store demographic" },
];
const EASY = [
  { name: "White sourdough", acc: 93, why: "High steady volume, clean weekday shape" },
  { name: "Plain bagel", acc: 91, why: "Consistent everyday staple" },
  { name: "Wholemeal sourdough", acc: 89, why: "Stable core line" },
];

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

export default function ForecastAccuracy() {
  const network = WEEKS[WEEKS.length - 1];
  const improve = network - WEEKS[WEEKS.length - 5];
  const onTrack = Math.round((STORES.filter((s) => s.acc >= 85).length / STORES.length) * 100);
  const netBias = Math.round(STORES.reduce((a, s) => a + s.bias, 0) / STORES.length);

  // Trend chart geometry
  const W = 720, H = 210, pL = 34, pR = 14, pT = 16, pB = 30;
  const yMin = 68, yMax = 92;
  const xs = (i: number) => pL + (i * (W - pL - pR)) / (WEEKS.length - 1);
  const ys = (v: number) => pT + (1 - (v - yMin) / (yMax - yMin)) * (H - pT - pB);
  const pts = WEEKS.map((v, i) => [xs(i), ys(v)] as [number, number]);
  const line = smoothPath(pts);
  const area = `${line} L ${xs(WEEKS.length - 1).toFixed(1)} ${H - pB} L ${pL} ${H - pB} Z`;
  const gridY = [70, 75, 80, 85, 90];

  return (
    <div className="facc">
      <div className="panel intro">
        <div className="itxt">
          Every order the engine sizes is scored against what the store actually sold. This is the honest scoreboard —
          how we prove waste is really coming down, not just claimed. <b>Over-forecasting leans to waste; under-forecasting
          leans to stockouts</b> — so the same number that grades the engine points to which of the other two problems a
          store has.
        </div>
      </div>

      {/* Strip */}
      <div className="strip">
        <div className="tile">
          <div className="tn">{network}<span className="u">%</span></div>
          <div className="tl">Network accuracy · units within ±15% of actual</div>
        </div>
        <div className="tile">
          <div className={`tn ${netBias > 0 ? "amber" : "blue"}`}>{netBias > 0 ? "+" : ""}{netBias}<span className="u">%</span></div>
          <div className="tl">Bias · {netBias > 0 ? "slightly over → leans waste" : "slightly under → leans stockout"}</div>
        </div>
        <div className="tile">
          <div className="tn green">+{improve}<span className="u"> pts</span></div>
          <div className="tl">Improvement vs 4 weeks ago</div>
        </div>
        <div className="tile">
          <div className="tn">{onTrack}<span className="u">%</span></div>
          <div className="tl">Stores at or above the 85% target</div>
        </div>
      </div>

      {/* Trend chart */}
      <div className="chartcard">
        <div className="cc-top">
          <div>
            <div className="cc-lbl">Forecast accuracy · last 8 weeks</div>
            <div className="cc-big">{network}<span className="u">%</span></div>
            <div className="cc-sub good">↑ {improve} points since the engine took over sizing</div>
          </div>
          <div className="cc-legend"><span className="dash" /> 85% target</div>
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
          <line x1={pL} y1={ys(TARGET)} x2={W - pR} y2={ys(TARGET)} stroke="var(--crust)" strokeWidth="1.3" strokeDasharray="4 4" opacity="0.7" />
          <path d={area} fill="url(#faccFill)" />
          <path d={line} fill="none" stroke="var(--crust)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          {pts.map((p, i) => <circle key={i} cx={p[0]} cy={p[1]} r={i === pts.length - 1 ? 4 : 2.5} fill="var(--crust)" />)}
          {WEEKS.map((_, i) => (
            <text key={i} x={xs(i)} y={H - 10} fontSize="10.5" fill="var(--muted)" textAnchor="middle">
              {i === WEEKS.length - 1 ? "now" : "w" + (i + 1)}
            </text>
          ))}
        </svg>
      </div>

      {/* Per-store table */}
      <div className="section-h" style={{ marginTop: 22, marginBottom: 10 }}><span className="tick" />Accuracy by store</div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr><th>Store</th><th className="num">Accuracy</th><th>Bias</th><th>6-week trend</th><th className="num">Flag</th></tr>
          </thead>
          <tbody>
            {STORES.map((s) => (
              <tr key={s.store}>
                <td><div className="stn">{s.store}</div><div className="str">{s.region}</div></td>
                <td className="num"><span className={`accpill ${accClass(s.acc)}`}>{s.acc}%</span></td>
                <td>
                  <span className={`bias ${s.bias > 0 ? "over" : "under"}`}>
                    {s.bias > 0 ? "+" : ""}{s.bias}% {s.bias > 0 ? "over → waste" : "under → stockout"}
                  </span>
                </td>
                <td><Spark vals={s.trend} /></td>
                <td className="num">{s.acc < 78 ? <span className="tag red">Model attention</span> : s.acc < 85 ? <span className="tag amber">Watch</span> : <span className="tag green">On track</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Product accuracy */}
      <div className="prodgrid">
        <div>
          <div className="section-h" style={{ marginTop: 22, marginBottom: 10 }}><span className="tick" />Hardest to forecast</div>
          <div className="panel" style={{ padding: 0 }}>
            {HARD.map((p, i) => (
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
            {EASY.map((p, i) => (
              <div className="prow" key={p.name} style={{ borderTop: i ? "1px solid var(--line2)" : undefined }}>
                <div className="pn">{p.name}<span className={`accpill ${accClass(p.acc)}`}>{p.acc}%</span></div>
                <div className="pw">{p.why}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="foot" style={{ marginTop: 16 }}>
        Representative. Scored by replaying the engine&apos;s forecasts against actual sales — backtestable on the ~615k
        historical forecast snapshots already in the data. Updates weekly and feeds the model&apos;s own tuning.
      </div>

      <style>{`
        .facc .intro{margin-bottom:16px}
        .facc .intro .itxt{font-size:14.5px;line-height:1.65;color:var(--ink2)}
        .facc .intro b{color:var(--ink);font-weight:600}
        .facc .strip{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}
        .facc .tile{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px}
        .facc .tn{font-family:var(--serif);font-size:32px;font-weight:600;line-height:1;letter-spacing:-.6px;font-variant-numeric:tabular-nums}
        .facc .tn .u{font-size:15px;color:var(--muted);font-family:var(--sans);font-weight:500}
        .facc .tn.green{color:var(--green-t)} .facc .tn.amber{color:var(--amber-t)} .facc .tn.blue{color:#4f7396}
        .facc .tl{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.4}

        .facc .chartcard .cc-top{display:flex;justify-content:space-between;align-items:flex-start}
        .facc .cc-big{font-family:var(--serif);font-size:38px;font-weight:600;line-height:1;letter-spacing:-1px;font-variant-numeric:tabular-nums;margin-top:6px}
        .facc .cc-big .u{font-size:.5em;color:var(--muted);font-weight:500}
        .facc .cc-legend{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:7px}
        .facc .cc-legend .dash{width:16px;height:0;border-top:1.5px dashed var(--crust);display:inline-block}
        .facc .trend{margin-top:6px;overflow:visible}

        .facc .stn{font-weight:600;font-size:13.5px}
        .facc .str{font-size:11.5px;color:var(--muted);margin-top:2px}
        .facc .accpill{display:inline-block;font-weight:700;font-size:12.5px;padding:3px 9px;border-radius:999px;font-variant-numeric:tabular-nums}
        .facc .accpill.green{background:var(--green-b);color:var(--green-t)}
        .facc .accpill.amber{background:var(--amber-b);color:var(--amber-t)}
        .facc .accpill.red{background:var(--red-b);color:var(--red-t)}
        .facc .bias{font-size:12.5px;font-weight:600}
        .facc .bias.over{color:var(--amber-t)} .facc .bias.under{color:#4f7396}

        .facc .prodgrid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
        .facc .prow{padding:13px 16px}
        .facc .pn{display:flex;align-items:center;gap:10px;font-family:var(--serif);font-size:14.5px;font-weight:600}
        .facc .pn .accpill{margin-left:auto}
        .facc .pw{font-size:12.5px;color:var(--muted);margin-top:4px;line-height:1.5}

        @media (max-width:1080px){ .facc .strip{grid-template-columns:1fr 1fr} .facc .prodgrid{grid-template-columns:1fr} }
      `}</style>
    </div>
  );
}
