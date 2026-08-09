"use client";
import { useRef, useState } from "react";

/**
 * Signature network-waste trend: a gentle Catmull-Rom curve with an
 * interactive hover crosshair + tooltip. `vals` is oldest -> newest (6 pts).
 */
export default function WasteChart({ vals }: { vals: number[] }) {
  const W = 320, H = 118, pL = 6, pR = 6, pT = 14, pB = 22;
  const max = Math.max(...vals), min = Math.min(...vals), rng = max - min || 1;
  const xs = (i: number) => pL + (i * (W - pL - pR)) / (vals.length - 1);
  const ys = (v: number) => pT + (1 - (v - min) / rng) * (H - pT - pB);
  const pts = vals.map((v, i) => [xs(i), ys(v)] as [number, number]);
  const wk = ["5 wks ago", "4 wks ago", "3 wks ago", "2 wks ago", "last wk", "this wk"];

  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  // Catmull-Rom -> cubic bezier, low tension so the line stays calm.
  const smooth = () => {
    if (pts.length < 3) return pts.map((p, i) => (i ? "L" : "M") + p[0] + " " + p[1]).join(" ");
    let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    const t = 0.16;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || pts[i + 1];
      const c1x = p1[0] + (p2[0] - p0[0]) * t, c1y = p1[1] + (p2[1] - p0[1]) * t;
      const c2x = p2[0] - (p3[0] - p1[0]) * t, c2y = p2[1] - (p3[1] - p1[1]) * t;
      d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`;
    }
    return d;
  };
  const line = smooth();
  const area = `${line} L ${xs(vals.length - 1).toFixed(1)} ${H - pB} L ${pL} ${H - pB} Z`;
  const last = pts[pts.length - 1];

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current; if (!svg) return;
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const loc = pt.matrixTransform(svg.getScreenCTM()!.inverse());
    let bi = 0, bd = 1e9;
    pts.forEach((p, i) => { const d = Math.abs(p[0] - loc.x); if (d < bd) { bd = d; bi = i; } });
    setHover(bi);
  };

  let tip = null;
  if (hover !== null) {
    const p = pts[hover];
    const label = `${wk[hover]} · ${vals[hover]}%`;
    const w = label.length * 5.7 + 16;
    const tx = Math.max(2, Math.min(W - w - 2, p[0] - w / 2));
    const ty = Math.max(0, p[1] - 26);
    tip = (
      <g>
        <line x1={p[0]} y1={pT} x2={p[0]} y2={H - pB} stroke="#b0741c" strokeWidth={1} strokeDasharray="3 3" opacity={0.55} />
        <circle cx={p[0]} cy={p[1]} r={4.2} fill="#b0741c" stroke="#fff" strokeWidth={1.5} />
        <rect x={tx} y={ty} width={w} height={19} rx={5} fill="#3a2f24" />
        <text x={tx + w / 2} y={ty + 13} fontSize={10.5} fontWeight={600} fill="#fff" textAnchor="middle" fontFamily="Inter">{label}</text>
      </g>
    );
  }

  return (
    <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%"
      style={{ display: "block", marginTop: 12, cursor: "crosshair" }}
      onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <defs>
        <linearGradient id="wg" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#b0741c" stopOpacity="0.18" />
          <stop offset="1" stopColor="#b0741c" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 1, 2].map((g) => {
        const y = pT + (g * (H - pT - pB)) / 2;
        return <line key={g} x1={pL} y1={y} x2={W - pR} y2={y} stroke="#e8dfcf" strokeWidth={1} opacity={0.7} />;
      })}
      <path d={area} fill="url(#wg)" />
      <path d={line} fill="none" stroke="#b0741c" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={3.6} fill="#b0741c" />
      {pts.map((p, i) => (
        <text key={i} x={p[0]} y={H - 6} fontSize={9} fill="#a89e8d" textAnchor="middle" fontFamily="Inter">
          {["w-5", "w-4", "w-3", "w-2", "w-1", "now"][i]}
        </text>
      ))}
      {tip}
    </svg>
  );
}
