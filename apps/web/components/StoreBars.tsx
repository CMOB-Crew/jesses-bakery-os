import type { DailyBar } from "@/lib/queries";

// Daily sold vs delivered — deliberately no running totals (Simona: cumulative
// bars are meaningless to her). Pure SVG, server-rendered.
export default function StoreBars({ data }: { data: DailyBar[] }) {
  const W = 460, H = 92;
  const n = Math.max(1, data.length);
  const max = Math.max(1, ...data.map((d) => Math.max(d.sold, d.sent)));
  const slot = W / n;
  // Cap the bar cluster width. Without this, a store with a single day of data
  // (prod currently carries one Saturday) stretches one bar across the whole
  // panel and renders as a big black block. Capped, a lone day shows as a normal
  // narrow bar pair centred in its slot; a full week is unaffected.
  const clusterW = Math.min(slot - 12, 44);
  const gw = Math.max(4, clusterW / 2 - 2);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: 520 }}>
      {data.map((d, i) => {
        const cx = i * slot + slot / 2;   // centre of this day's slot
        const x = cx - clusterW / 2;      // left edge of the bar cluster
        const sh = Math.round((d.sold / max) * (H - 20));
        const dh = Math.round((d.sent / max) * (H - 20));
        return (
          <g key={i}>
            <rect x={x} y={H - 16 - dh} width={gw} height={dh} rx={3} fill="#e7ddca" />
            <rect x={x + gw + 4} y={H - 16 - sh} width={gw} height={sh} rx={3} fill="#2a2019" />
            <text x={cx} y={H - 4} fontSize={9.5} fill="#a89e8d" textAnchor="middle" fontFamily="Inter">{d.dow}</text>
          </g>
        );
      })}
    </svg>
  );
}
