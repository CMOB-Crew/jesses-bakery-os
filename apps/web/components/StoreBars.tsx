import type { DailyBar } from "@/lib/queries";

// Daily sold vs delivered — deliberately no running totals (Simona: cumulative
// bars are meaningless to her). Pure SVG, server-rendered.
const WEEK = [
  { k: "mon", l: "Mon" }, { k: "tue", l: "Tue" }, { k: "wed", l: "Wed" },
  { k: "thu", l: "Thu" }, { k: "fri", l: "Fri" }, { k: "sat", l: "Sat" }, { k: "sun", l: "Sun" },
];

export default function StoreBars({ data }: { data: DailyBar[] }) {
  const W = 460, H = 92;

  // Lay the loaded days onto a full Mon–Sun week: real bars on the days we have,
  // faint placeholder bars on the days we don't. So a partial feed (prod
  // currently carries a single Saturday) reads as "a week filling in" rather than
  // one lonely bar stranded in an empty box.
  const byDow = new Map<number, DailyBar>();
  for (const d of data) {
    const idx = WEEK.findIndex((w) => d.dow.toLowerCase().startsWith(w.k));
    if (idx >= 0) byDow.set(idx, d);
  }
  // Fallback: if the day labels don't match our week (unexpected format), just
  // draw the real bars left-to-right with no placeholders.
  const useWeek = byDow.size > 0;
  const days = useWeek
    ? WEEK.map((w, i) => ({ label: w.l, d: byDow.get(i) ?? null }))
    : data.map((d) => ({ label: d.dow, d }));
  const loaded = data.length;
  const partial = useWeek && loaded < 7;
  const firstDay = data[0]?.dow ?? "";

  const n = days.length;
  const max = Math.max(1, ...data.map((d) => Math.max(d.sold, d.sent)));
  const slot = W / n;
  // Cap the bar cluster so a lone day stays a normal narrow bar pair, not a block.
  const clusterW = Math.min(slot - 12, 44);
  const gw = Math.max(4, clusterW / 2 - 2);
  const ghostH = 14;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: 520 }}>
        {days.map((day, i) => {
          const cx = i * slot + slot / 2;   // centre of this day's slot
          const x = cx - clusterW / 2;      // left edge of the bar cluster
          if (!day.d) {
            // Placeholder — a faint low bar pair marking a day still to load.
            return (
              <g key={i} opacity="0.7">
                <rect x={x} y={H - 16 - ghostH} width={gw} height={ghostH} rx={3} fill="#e9e0cf" />
                <rect x={x + gw + 4} y={H - 16 - ghostH} width={gw} height={ghostH} rx={3} fill="#e9e0cf" />
                <text x={cx} y={H - 4} fontSize={9.5} fill="#c3b8a4" textAnchor="middle" fontFamily="Inter">{day.label}</text>
              </g>
            );
          }
          const sh = Math.round((day.d.sold / max) * (H - 20));
          const dh = Math.round((day.d.sent / max) * (H - 20));
          return (
            <g key={i}>
              {/* Delivered — pale, so a thin outline keeps it visible on the white card. */}
              <rect x={x} y={H - 16 - dh} width={gw} height={dh} rx={3} fill="#e7ddca" stroke="#d3c5a8" strokeWidth="0.75" />
              <rect x={x + gw + 4} y={H - 16 - sh} width={gw} height={sh} rx={3} fill="#2a2019" />
              <text x={cx} y={H - 4} fontSize={9.5} fill="#a89e8d" textAnchor="middle" fontFamily="Inter">{day.label}</text>
            </g>
          );
        })}
      </svg>
      {partial && (
        <div style={{ marginTop: 6, fontSize: 12, color: "#9a8d78", lineHeight: 1.45 }}>
          {loaded === 1
            ? `Only ${firstDay}'s feed is loaded so far — the other days fill in with your full sales history.`
            : `Only ${loaded} days of feed loaded so far — the rest fill in with your full sales history.`}
        </div>
      )}
    </div>
  );
}
