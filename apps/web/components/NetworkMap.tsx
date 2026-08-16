"use client";
import { useState } from "react";
import type { MapStore } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Network map — the whole active network at a glance. A readable region
 * diagram (a far-flung run like Canberra would squash a true-scale GPS
 * plot), populated entirely from live data: real region membership, real
 * status, real counts and volumes. Same 🟢🟡🔴 logic as everywhere else.
 * Regions are placed to read cleanly; the dots are the real network.
 * ------------------------------------------------------------------ */

type Status = "green" | "amber" | "red";
const COLOR: Record<Status, string> = { green: "var(--green)", amber: "var(--amber)", red: "var(--red)" };
const STLABEL: Record<Status, string> = { green: "On track", amber: "Watch", red: "Needs attention" };

// Region frames, laid out to read like the Sydney basin + Canberra to the SW.
const ZONES: Record<string, { x: number; y: number; w: number; h: number; note?: string }> = {
  "North West": { x: 40, y: 150, w: 250, h: 190 },
  "North Shore": { x: 470, y: 120, w: 250, h: 175 },
  "Inner West": { x: 320, y: 330, w: 220, h: 170 },
  "Eastern Suburbs": { x: 620, y: 320, w: 230, h: 210 },
  "Canberra / ACT": { x: 40, y: 400, w: 250, h: 190, note: "~3 hrs south-west" },
  "Central Coast": { x: 470, y: 320, w: 130, h: 130 },
  "Northern Beaches": { x: 740, y: 120, w: 170, h: 175 },
};
const FALLBACK = { x: 620, y: 560, w: 290, h: 30 }; // any region without a frame

export default function NetworkMap({ stores }: { stores: MapStore[] }) {
  const worst = [...stores].filter((s) => s.status === "red").sort((a, b) => Number(b.waste_pct ?? 0) - Number(a.waste_pct ?? 0));
  const [sel, setSel] = useState<MapStore | null>(worst[0] ?? stores[0] ?? null);
  const [hover, setHover] = useState<string | null>(null);

  if (!stores.length) {
    return (
      <div className="nmap">
        <div className="panel intro">
          <div className="itxt">The whole network at a glance, coloured by status. It reads from the live store list — stores appear here grouped by region as the network loads.</div>
        </div>
      </div>
    );
  }

  const counts: Record<Status, number> = { green: 0, amber: 0, red: 0 };
  stores.forEach((s) => (counts[s.status] += 1));
  const sent = stores.reduce((a, s) => a + Number(s.sent), 0);
  const sold = stores.reduce((a, s) => a + Number(s.sold), 0);
  const wastePct = sent > 0 ? Math.round((1000 * (sent - sold)) / sent) / 10 : 0;
  const maxSent = Math.max(...stores.map((s) => Number(s.sent)), 1);

  // Group by region; unknown regions collapse into a fallback strip.
  const byRegion = new Map<string, MapStore[]>();
  for (const s of stores) {
    const rn = s.region ?? "Other";
    const key = ZONES[rn] ? rn : "Other";
    if (!byRegion.has(key)) byRegion.set(key, []);
    byRegion.get(key)!.push(s);
  }

  // Pack a region's stores into a grid inside its frame.
  type Placed = { s: MapStore; x: number; y: number };
  const placed: Placed[] = [];
  const drawnZones: { key: string; z: { x: number; y: number; w: number; h: number; note?: string } }[] = [];
  for (const [key, ss] of byRegion) {
    const z = ZONES[key] ?? FALLBACK;
    drawnZones.push({ key, z });
    const n = ss.length;
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const x0 = z.x + 20, y0 = z.y + 44, iw = z.w - 40, ih = Math.max(28, z.h - 58);
    const cw = iw / cols, ch = ih / rows;
    ss.forEach((s, i) => {
      placed.push({ s, x: x0 + (i % cols) * cw + cw / 2, y: y0 + Math.floor(i / cols) * ch + ch / 2 });
    });
  }
  const r = (s: MapStore) => 6 + (Number(s.sent) / maxSent) * 6;
  const W = 940, H = 610;

  return (
    <div className="nmap">
      <div className="panel intro">
        <div className="itxt">
          The whole active network in one look, grouped by region and coloured by this week&apos;s status. Trouble clusters
          jump out — the coast and inner-west sit green while the far-flung runs run hot. Click any store for its read.
          Real membership, status and volume; the layout reads as a diagram, not a to-scale map.
        </div>
      </div>

      <div className="grid2">
        <div className="mapcard">
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Store network map">
            <defs>
              <linearGradient id="water" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#dfe9ea" stopOpacity="0" /><stop offset="1" stopColor="#cfe0e2" stopOpacity="0.55" />
              </linearGradient>
            </defs>
            <rect x={W - 64} y={0} width={64} height={H} fill="url(#water)" />
            <text x={W - 30} y={90} fontSize="12" fill="#7fa0a1" textAnchor="middle" transform={`rotate(90 ${W - 30} 90)`}>East / coast</text>

            {drawnZones.map(({ key, z }) => (
              <g key={key}>
                <rect x={z.x} y={z.y} width={z.w} height={z.h} rx="18" fill="#efe7d5" stroke="#e0d5bf" strokeWidth="1.5" />
                <text x={z.x + 16} y={z.y + 26} fontSize="14" fontWeight="700" fill="#8a8071" style={{ letterSpacing: ".2px" }}>{key === "Other" ? "Other regions" : key}</text>
                {z.note && <text x={z.x + 16} y={z.y + 43} fontSize="11" fill="#a89e8d">{z.note}</text>}
              </g>
            ))}

            {placed.map(({ s, x, y }) => {
              const on = hover === s.store_id || sel?.store_id === s.store_id;
              return (
                <g key={s.store_id} style={{ cursor: "pointer" }}
                   onMouseEnter={() => setHover(s.store_id)} onMouseLeave={() => setHover(null)} onClick={() => setSel(s)}>
                  {on && <circle cx={x} cy={y} r={r(s) + 6} fill={COLOR[s.status]} opacity="0.16" />}
                  <circle cx={x} cy={y} r={r(s)} fill={COLOR[s.status]} stroke="#fff" strokeWidth="2.4" />
                  {on && (
                    <g>
                      <rect x={x + r(s) + 6} y={y - 15} width={s.name.length * 6.2 + 16} height="26" rx="6" fill="#211c16" />
                      <text x={x + r(s) + 14} y={y + 3} fontSize="12.5" fill="#f3e9d6" fontWeight="600">{s.name}</text>
                    </g>
                  )}
                </g>
              );
            })}
          </svg>
          <div className="maplegend">
            {(["green", "amber", "red"] as Status[]).map((st) => (
              <span className="lg" key={st}><i style={{ background: COLOR[st] }} />{STLABEL[st]} · {counts[st]}</span>
            ))}
            <span className="lg dim">dot size = weekly volume</span>
          </div>
        </div>

        <div className="rail">
          <div className="panel sumcard">
            <div className="sc-h">Network this week</div>
            <div className="sc-big">{wastePct}<span className="u">% waste</span></div>
            <div className="sc-counts">
              <span className="c green">{counts.green} on track</span>
              <span className="c amber">{counts.amber} watch</span>
              <span className="c red">{counts.red} attention</span>
            </div>
            <div className="sc-meta">{stores.length} stores mapped · {sent.toLocaleString("en-AU")} sent · {sold.toLocaleString("en-AU")} sold / wk</div>
          </div>

          {sel && (
            <div className="panel detail">
              <div className="d-top"><span className="d-dot" style={{ background: COLOR[sel.status] }} /><span className="d-name">{sel.name}</span></div>
              <div className="d-meta">{sel.retailer} · {sel.region ?? "—"}</div>
              <div className="d-stats">
                <div className="ds"><div className="dn">{sel.waste_pct ?? "—"}%</div><div className="dl">waste</div></div>
                <div className="ds"><div className="dn">{sel.sent}</div><div className="dl">sent / wk</div></div>
                <div className="ds"><div className="dn">{sel.sold}</div><div className="dl">sold / wk</div></div>
              </div>
              <div className={`d-status ${sel.status}`}>{STLABEL[sel.status]}</div>
            </div>
          )}

          {worst.length > 0 && (
            <>
              <div className="section-h" style={{ margin: "6px 0 8px" }}><span className="tick" />Needs attention</div>
              <div className="panel worst" style={{ padding: 0 }}>
                {worst.slice(0, 6).map((s, i) => (
                  <button className={`wrow${sel?.store_id === s.store_id ? " on" : ""}`} key={s.store_id} style={{ borderTop: i ? "1px solid var(--line2)" : undefined }}
                          onClick={() => setSel(s)} onMouseEnter={() => setHover(s.store_id)} onMouseLeave={() => setHover(null)}>
                    <span className="w-dot" style={{ background: COLOR[s.status] }} />
                    <span className="w-name">{s.name}</span>
                    <span className="w-waste">{s.waste_pct}%</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="foot" style={{ marginTop: 16 }}>
        Live from the store master and the store-week view. Stores are grouped by their real region and coloured by the
        same status logic as the dashboards, benchmarks and store profiles.
      </div>

      <style>{`
        .nmap .intro{margin-bottom:16px}
        .nmap .intro .itxt{font-size:14.5px;line-height:1.65;color:var(--ink2)}
        .nmap .intro b{color:var(--ink);font-weight:600}
        .nmap .grid2{display:grid;grid-template-columns:1.7fr 1fr;gap:18px;align-items:start}
        .nmap .mapcard{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:14px}
        .nmap svg{display:block;border-radius:10px;background:linear-gradient(135deg,#f7f2e8,#f2ece0)}
        .nmap .maplegend{display:flex;gap:16px;flex-wrap:wrap;padding:12px 6px 4px}
        .nmap .lg{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;color:var(--ink2);font-weight:600}
        .nmap .lg.dim{color:var(--muted);font-weight:500;margin-left:auto}
        .nmap .lg i{width:11px;height:11px;border-radius:50%}

        .nmap .rail{position:sticky;top:16px;display:flex;flex-direction:column;gap:14px}
        .nmap .sumcard{padding:18px 20px}
        .nmap .sc-h{font-size:11px;letter-spacing:1px;text-transform:uppercase;color:var(--muted);font-weight:700}
        .nmap .sc-big{font-family:var(--serif);font-size:38px;font-weight:600;line-height:1;letter-spacing:-1px;margin-top:8px;font-variant-numeric:tabular-nums}
        .nmap .sc-big .u{font-size:15px;color:var(--muted);font-family:var(--sans);font-weight:500}
        .nmap .sc-counts{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
        .nmap .c{font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px}
        .nmap .c.green{background:var(--green-b);color:var(--green-t)}
        .nmap .c.amber{background:var(--amber-b);color:var(--amber-t)}
        .nmap .c.red{background:var(--red-b);color:var(--red-t)}
        .nmap .sc-meta{font-size:12px;color:var(--muted);margin-top:12px}

        .nmap .detail{padding:16px 18px}
        .nmap .d-top{display:flex;align-items:center;gap:9px}
        .nmap .d-dot{width:12px;height:12px;border-radius:50%;flex:none}
        .nmap .d-name{font-family:var(--serif);font-size:16px;font-weight:600}
        .nmap .d-meta{font-size:12.5px;color:var(--muted);margin-top:4px}
        .nmap .d-stats{display:flex;gap:10px;margin-top:14px}
        .nmap .ds{flex:1;background:var(--surface);border:1px solid var(--line2);border-radius:10px;padding:10px 12px;text-align:center}
        .nmap .dn{font-family:var(--serif);font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
        .nmap .dl{font-size:11px;color:var(--muted);margin-top:3px}
        .nmap .d-status{margin-top:12px;font-size:12.5px;font-weight:700;padding:6px 11px;border-radius:8px;display:inline-block}
        .nmap .d-status.green{background:var(--green-b);color:var(--green-t)}
        .nmap .d-status.amber{background:var(--amber-b);color:var(--amber-t)}
        .nmap .d-status.red{background:var(--red-b);color:var(--red-t)}

        .nmap .worst{overflow:hidden}
        .nmap .wrow{display:flex;align-items:center;gap:10px;width:100%;padding:11px 14px;background:var(--card);border:none;cursor:pointer;font-family:inherit;text-align:left}
        .nmap .wrow:hover,.nmap .wrow.on{background:#faf6ee}
        .nmap .w-dot{width:9px;height:9px;border-radius:50%;flex:none}
        .nmap .w-name{font-size:13px;font-weight:600;color:var(--ink)}
        .nmap .w-waste{margin-left:auto;font-size:12.5px;font-weight:700;color:var(--red-t);font-variant-numeric:tabular-nums}

        @media (max-width:1080px){ .nmap .grid2{grid-template-columns:1fr} .nmap .rail{position:static} }
      `}</style>
    </div>
  );
}
