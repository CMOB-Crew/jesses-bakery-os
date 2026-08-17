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

  // Group by the store's REAL region — no hardcoded region names, so the
  // diagram works whatever the regions are actually called.
  const byRegion = new Map<string, MapStore[]>();
  for (const s of stores) {
    const rn = (s.region ?? "").trim() || "Unassigned";
    if (!byRegion.has(rn)) byRegion.set(rn, []);
    byRegion.get(rn)!.push(s);
  }
  // Biggest regions first (most red, then most stores) so trouble reads top-left.
  const regionList = [...byRegion.entries()].sort((a, b) => {
    const redA = a[1].filter((s) => s.status === "red").length;
    const redB = b[1].filter((s) => s.status === "red").length;
    return redB - redA || b[1].length - a[1].length || a[0].localeCompare(b[0]);
  });

  // Lay the regions out as a responsive grid of frames that fills the canvas.
  const W = 940;
  const PAD = 14, GAP = 12, HEAD = 40;
  const n = regionList.length;
  const cols = Math.min(4, Math.max(1, Math.round(Math.sqrt(n))));
  const rowsN = Math.ceil(n / cols);
  const cellW = (W - PAD * 2 - GAP * (cols - 1)) / cols;
  const cellH = 168; // fixed frame height; canvas grows with row count
  const H = PAD * 2 + rowsN * cellH + (rowsN - 1) * GAP;

  // Pack each region's dots into a grid inside its frame; radius is capped to
  // the packing cell so dense regions don't overlap.
  type Placed = { s: MapStore; x: number; y: number; maxR: number };
  const placed: Placed[] = [];
  const drawnZones: { key: string; count: number; x: number; y: number; w: number; h: number }[] = [];
  regionList.forEach(([key, ss], idx) => {
    const c = idx % cols, rrow = Math.floor(idx / cols);
    const x = PAD + c * (cellW + GAP);
    const y = PAD + rrow * (cellH + GAP);
    drawnZones.push({ key, count: ss.length, x, y, w: cellW, h: cellH });
    const gcols = Math.ceil(Math.sqrt(ss.length));
    const grows = Math.ceil(ss.length / gcols);
    const x0 = x + 16, y0 = y + HEAD, iw = cellW - 32, ih = Math.max(20, cellH - HEAD - 12);
    const cw = iw / gcols, ch = ih / grows;
    const maxR = Math.max(2.6, Math.min(9, Math.min(cw, ch) / 2 - 1.5));
    ss.forEach((s, i) => {
      placed.push({ s, x: x0 + (i % gcols) * cw + cw / 2, y: y0 + Math.floor(i / gcols) * ch + ch / 2, maxR });
    });
  });
  const rOf = (s: MapStore, maxR: number) => Math.min(maxR, 4 + (Number(s.sent) / maxSent) * 5);

  return (
    <div className="nmap">
      <div className="panel intro">
        <div className="itxt">
          The whole active network in one look, grouped by its real region and coloured by this week&apos;s status.
          Trouble clusters jump out — the regions with the most red sit top-left. Click any store for its read. Real
          membership, status and volume; the layout reads as a diagram, not a to-scale map.
        </div>
      </div>

      <div className="grid2">
        <div className="mapcard">
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Store network map">
            {drawnZones.map(({ key, count, x, y, w, h }) => (
              <g key={key}>
                <rect x={x} y={y} width={w} height={h} rx="16" fill="#efe7d5" stroke="#e0d5bf" strokeWidth="1.5" />
                <text x={x + 15} y={y + 24} fontSize="13.5" fontWeight="700" fill="#8a8071" style={{ letterSpacing: ".2px" }}>{key}</text>
                <text x={x + w - 15} y={y + 24} fontSize="12" fontWeight="600" fill="#a89e8d" textAnchor="end">{count}</text>
              </g>
            ))}

            {placed.map(({ s, x, y, maxR }) => {
              const on = hover === s.store_id || sel?.store_id === s.store_id;
              const rr = rOf(s, maxR);
              return (
                <g key={s.store_id} style={{ cursor: "pointer" }}
                   onMouseEnter={() => setHover(s.store_id)} onMouseLeave={() => setHover(null)} onClick={() => setSel(s)}>
                  {on && <circle cx={x} cy={y} r={rr + 5} fill={COLOR[s.status]} opacity="0.16" />}
                  <circle cx={x} cy={y} r={rr} fill={COLOR[s.status]} stroke="#fff" strokeWidth="1.8" />
                  {on && (
                    <g>
                      <rect x={x + rr + 6} y={y - 15} width={s.name.length * 6.2 + 16} height="26" rx="6" fill="#211c16" />
                      <text x={x + rr + 14} y={y + 3} fontSize="12.5" fill="#f3e9d6" fontWeight="600">{s.name}</text>
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
