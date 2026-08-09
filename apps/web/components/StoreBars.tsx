import type { DailyBar } from "@/lib/queries";

// Daily sold vs delivered — deliberately no running totals (Simona: cumulative
// bars are meaningless to her). Pure SVG, server-rendered.
export default function StoreBars({ data }: { data: DailyBar[] }) {
  const W = 460, H = 92;
  const max = Math.max(1, ...data.map((d) => Math.max(d.sold, d.sent)));
  const bw = W / Math.max(1, data.length);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: 520 }}>
      {data.map((d, i) => {
        const x = i * bw + 6, gw = (bw - 16) / 2;
        const sh = Math.round((d.sold / max) * (H - 20));
        const dh = Math.round((d.sent / max) * (H - 20));
        return (
          <g key={i}>
            <rect x={x} y={H - 16 - dh} width={gw} height={dh} rx={3} fill="#e7ddca" />
            <rect x={x + gw + 3} y={H - 16 - sh} width={gw} height={sh} rx={3} fill="#2a2019" />
            <text x={x + (bw - 16) / 2} y={H - 4} fontSize={9.5} fill="#a89e8d" textAnchor="middle" fontFamily="Inter">{d.dow}</text>
          </g>
        );
      })}
    </svg>
  );
}
