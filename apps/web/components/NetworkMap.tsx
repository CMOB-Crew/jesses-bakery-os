"use client";
import { useState } from "react";

/* ------------------------------------------------------------------ *
 * Network map — the whole store network at a glance, laid out
 * geographically and coloured by status. Where the trouble clusters is
 * obvious in a second (Canberra runs hot). Self-contained schematic
 * (no map tiles) so it renders anywhere; the live app plots real
 * lat/long from Stores_Master. Front-end prototype.
 * ------------------------------------------------------------------ */

type Status = "green" | "amber" | "red";
type Store = { id: string; name: string; retailer: string; region: string; status: Status; waste: number; sent: number; sold: number; x: number; y: number };

const STORES: Store[] = [
  // Eastern Suburbs (coast, east)
  { id: "bondi-junction", name: "Woolworths Bondi Junction", retailer: "Woolworths", region: "Eastern Suburbs", status: "green", waste: 12.5, sent: 640, sold: 560, x: 800, y: 330 },
  { id: "bondi-beach", name: "Woolworths Bondi Beach", retailer: "Woolworths", region: "Eastern Suburbs", status: "green", waste: 9.0, sent: 610, sold: 555, x: 862, y: 378 },
  { id: "double-bay", name: "Coles Double Bay", retailer: "Coles", region: "Eastern Suburbs", status: "green", waste: 15.4, sent: 520, sold: 440, x: 812, y: 296 },
  { id: "randwick", name: "Woolworths Randwick", retailer: "Woolworths", region: "Eastern Suburbs", status: "amber", waste: 21.0, sent: 600, sold: 474, x: 840, y: 440 },
  // Inner West (centre)
  { id: "ashfield", name: "Coles Ashfield", retailer: "Coles", region: "Inner West", status: "green", waste: 10.0, sent: 430, sold: 387, x: 560, y: 402 },
  { id: "marrickville", name: "Coles Marrickville", retailer: "Coles", region: "Inner West", status: "green", waste: 17.1, sent: 410, sold: 340, x: 614, y: 452 },
  { id: "leichhardt", name: "Harris Farm Leichhardt", retailer: "Harris Farm", region: "Inner West", status: "green", waste: 18.9, sent: 380, sold: 308, x: 540, y: 438 },
  // North Shore (north-east)
  { id: "chatswood", name: "Woolworths Chatswood", retailer: "Woolworths", region: "North Shore", status: "green", waste: 16.1, sent: 560, sold: 470, x: 760, y: 196 },
  { id: "mosman", name: "Harris Farm Mosman", retailer: "Harris Farm", region: "North Shore", status: "amber", waste: 20.0, sent: 400, sold: 320, x: 838, y: 246 },
  { id: "neutral-bay", name: "Woolworths Neutral Bay", retailer: "Woolworths", region: "North Shore", status: "green", waste: 16.7, sent: 360, sold: 300, x: 800, y: 288 },
  // North West (inland)
  { id: "rouse-hill", name: "Woolworths Rouse Hill", retailer: "Woolworths", region: "North West", status: "red", waste: 39.7, sent: 580, sold: 350, x: 330, y: 226 },
  { id: "castle-hill", name: "Coles Castle Hill", retailer: "Coles", region: "North West", status: "green", waste: 18.2, sent: 440, sold: 360, x: 424, y: 292 },
  // Canberra / ACT (detached, far south-west)
  { id: "gungahlin", name: "Woolworths Gungahlin", retailer: "Woolworths", region: "Canberra / ACT", status: "red", waste: 37.5, sent: 480, sold: 300, x: 232, y: 500 },
  { id: "belconnen", name: "Coles Belconnen", retailer: "Coles", region: "Canberra / ACT", status: "red", waste: 28.6, sent: 420, sold: 300, x: 188, y: 542 },
  { id: "woden", name: "Woolworths Woden", retailer: "Woolworths", region: "Canberra / ACT", status: "red", waste: 34.8, sent: 460, sold: 300, x: 250, y: 574 },
  { id: "tuggeranong", name: "Woolworths Tuggeranong", retailer: "Woolworths", region: "Canberra / ACT", status: "amber", waste: 26.0, sent: 400, sold: 296, x: 288, y: 596 },
];

const ZONES: { label: string; x: number; y: number; w: number; h: number; note?: string }[] = [
  { label: "North West", x: 270, y: 168, w: 220, h: 168 },
  { label: "North Shore", x: 700, y: 150, w: 210, h: 168 },
  { label: "Inner West", x: 490, y: 356, w: 190, h: 150 },
  { label: "Eastern Suburbs", x: 752, y: 268, w: 170, h: 218 },
  { label: "Canberra · ACT", x: 130, y: 452, w: 230, h: 170, note: "~3 hrs south-west" },
];

const COLOR: Record<Status, string> = { green: "var(--green)", amber: "var(--amber)", red: "var(--red)" };
const STLABEL: Record<Status, string> = { green: "On track", amber: "Watch", red: "Needs attention" };

export default function NetworkMap() {
  const [sel, setSel] = useState<Store | null>(STORES.find((s) => s.id === "gungahlin") ?? null);
  const [hover, setHover] = useState<string | null>(null);

  const counts = { green: 0, amber: 0, red: 0 } as Record<Status, number>;
  STORES.forEach((s) => (counts[s.status] += 1));
  const sent = STORES.reduce((a, s) => a + s.sent, 0);
  const sold = STORES.reduce((a, s) => a + s.sold, 0);
  const wastePct = Math.round((1000 * (sent - sold)) / sent) / 10;
  const worst = [...STORES].filter((s) => s.status === "red").sort((a, b) => b.waste - a.waste);
  const r = (s: Store) => 7 + (s.sent / 640) * 7;

  return (
    <div className="nmap">
      <div className="panel intro">
        <div className="itxt">
          The whole network in one look, coloured by status. Trouble clusters jump out — <b>Canberra runs hot</b>, the
          coast and inner-west sit green. Click any store for its read. Live, this plots real store coordinates; the
          colours are the same R/A/G the rest of the system uses.
        </div>
      </div>

      <div className="grid2">
        <div className="mapcard">
          <svg viewBox="0 0 1000 640" width="100%" role="img" aria-label="Store network map">
            <defs>
              <linearGradient id="water" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#dfe9ea" stopOpacity="0" /><stop offset="1" stopColor="#cfe0e2" stopOpacity="0.7" />
              </linearGradient>
            </defs>
            {/* water / coast on the east */}
            <path d="M905 60 C 930 180, 900 300, 940 420 C 965 500, 940 580, 960 620 L 1000 620 L 1000 60 Z" fill="url(#water)" />
            <path d="M905 60 C 930 180, 900 300, 940 420 C 965 500, 940 580, 960 620" fill="none" stroke="#a9c3c4" strokeWidth="2" strokeDasharray="2 5" opacity="0.7" />
            <text x={958} y={110} fontSize="12" fill="#7fa0a1" textAnchor="middle" transform="rotate(90 958 110)">Tasman Sea</text>

            {/* region zones */}
            {ZONES.map((z) => (
              <g key={z.label}>
                <rect x={z.x} y={z.y} width={z.w} height={z.h} rx="20" fill="#efe7d5" stroke="#e0d5bf" strokeWidth="1.5" />
                <text x={z.x + 14} y={z.y + 24} fontSize="14" fontWeight="700" fill="#8a8071" style={{ letterSpacing: ".3px" }}>{z.label}</text>
                {z.note && <text x={z.x + 14} y={z.y + 42} fontSize="11" fill="#a89e8d">{z.note}</text>}
              </g>
            ))}
            {/* a hint of separation for Canberra */}
            <line x1={370} y1={470} x2={430} y2={430} stroke="#d8ccb6" strokeWidth="2" strokeDasharray="3 5" />

            {/* store dots */}
            {STORES.map((s) => {
              const on = hover === s.id || sel?.id === s.id;
              return (
                <g key={s.id} style={{ cursor: "pointer" }}
                   onMouseEnter={() => setHover(s.id)} onMouseLeave={() => setHover(null)} onClick={() => setSel(s)}>
                  {on && <circle cx={s.x} cy={s.y} r={r(s) + 7} fill={COLOR[s.status]} opacity="0.16" />}
                  <circle cx={s.x} cy={s.y} r={r(s)} fill={COLOR[s.status]} stroke="#fff" strokeWidth="2.5" />
                  {on && (
                    <g>
                      <rect x={s.x + r(s) + 6} y={s.y - 15} width={s.name.length * 6.2 + 16} height="26" rx="6" fill="#211c16" />
                      <text x={s.x + r(s) + 14} y={s.y + 3} fontSize="12.5" fill="#f3e9d6" fontWeight="600">{s.name}</text>
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
            <div className="sc-meta">{STORES.length} stores · {sent.toLocaleString("en-AU")} sent · {sold.toLocaleString("en-AU")} sold / wk</div>
          </div>

          {sel && (
            <div className="panel detail">
              <div className="d-top"><span className="d-dot" style={{ background: COLOR[sel.status] }} /><span className="d-name">{sel.name}</span></div>
              <div className="d-meta">{sel.retailer} · {sel.region}</div>
              <div className="d-stats">
                <div className="ds"><div className="dn">{sel.waste}%</div><div className="dl">waste</div></div>
                <div className="ds"><div className="dn">{sel.sent}</div><div className="dl">sent / wk</div></div>
                <div className="ds"><div className="dn">{sel.sold}</div><div className="dl">sold / wk</div></div>
              </div>
              <div className={`d-status ${sel.status}`}>{STLABEL[sel.status]}</div>
            </div>
          )}

          <div className="section-h" style={{ margin: "6px 0 8px" }}><span className="tick" />Needs attention</div>
          <div className="panel worst" style={{ padding: 0 }}>
            {worst.map((s, i) => (
              <button className={`wrow${sel?.id === s.id ? " on" : ""}`} key={s.id} style={{ borderTop: i ? "1px solid var(--line2)" : undefined }}
                      onClick={() => setSel(s)} onMouseEnter={() => setHover(s.id)} onMouseLeave={() => setHover(null)}>
                <span className="w-dot" style={{ background: COLOR[s.status] }} />
                <span className="w-name">{s.name}</span>
                <span className="w-waste">{s.waste}%</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="foot" style={{ marginTop: 16 }}>
        Representative layout. In the live app stores sit on their real coordinates from the store master, and the map
        shares the same status logic as the dashboards, benchmarks and store profiles.
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
