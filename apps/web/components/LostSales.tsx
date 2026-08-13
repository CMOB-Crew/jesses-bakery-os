"use client";
import { useMemo, useState } from "react";

/* ------------------------------------------------------------------ *
 * Lost sales / stockouts — the availability mirror of waste. Waste is
 * baking too much; lost sales is selling out early and turning demand
 * away. The service dial trades between the two. Simona: "we definitely
 * need a lost-sales / stockout algorithm."
 *
 * Front-end prototype. The detection (received vs sold-through, sellout
 * timing) is Fred's engine; this is the view that surfaces each miss
 * with a one-tap fix, plus the bulk option she asked for. Examples are
 * representative of the pattern — they light up on live detection.
 * ------------------------------------------------------------------ */

type Conf = "high" | "medium";
type Loss = {
  id: string;
  store: string;
  retailer: string;
  region: string;
  product: string;
  day: string;
  pattern: string;
  lostWk: number; // estimated lost units / week
  current: number;
  suggested: number;
  conf: Conf;
  cadence?: boolean; // structural — 2-deliveries/week risk
};

const LOSSES: Loss[] = [
  { id: "l1", store: "Woolworths Bondi Junction", retailer: "Woolworths", region: "Eastern Suburbs",
    product: "White sourdough", day: "Saturday", pattern: "Received 20, gone by ~11am every Saturday — steady walk-aways after.",
    lostWk: 9, current: 20, suggested: 28, conf: "high" },
  { id: "l2", store: "Harris Farm Mosman", retailer: "Harris Farm", region: "North Shore",
    product: "Plain challah", day: "Friday", pattern: "Sells through by noon Fridays (Shabbat) — no stock for the afternoon rush.",
    lostWk: 6, current: 8, suggested: 13, conf: "high" },
  { id: "l3", store: "Coles Ashfield", retailer: "Coles", region: "Inner West",
    product: "Sesame bagel", day: "Friday", pattern: "Out by ~2pm most Fridays; Fri is the peak day on this run.",
    lostWk: 7, current: 16, suggested: 22, conf: "high" },
  { id: "l4", store: "Coles Belconnen", retailer: "Coles", region: "Canberra / ACT",
    product: "White sourdough", day: "Wednesday", pattern: "Only 2 drops/week (Mon & Thu). Repeat sellouts Wednesday before the Thursday delivery.",
    lostWk: 12, current: 24, suggested: 32, conf: "medium", cadence: true },
  { id: "l5", store: "Woolworths Tuggeranong", retailer: "Woolworths", region: "Canberra / ACT",
    product: "Wholemeal sourdough", day: "Saturday", pattern: "Same 2/week cadence — weekend sourdough gone Saturday morning, dry until Monday.",
    lostWk: 10, current: 18, suggested: 26, conf: "medium", cadence: true },
  { id: "l6", store: "Coles Rouse Hill", retailer: "Coles", region: "North West",
    product: "Mini bagels", day: "Midweek", pattern: "School-holiday lift not captured — selling out midday through the break.",
    lostWk: 6, current: 14, suggested: 19, conf: "medium" },
];

const CONF_META: Record<Conf, { label: string; c: string; b: string }> = {
  high: { label: "High confidence", c: "var(--green-t)", b: "var(--green-b)" },
  medium: { label: "Worth a look", c: "var(--amber-t)", b: "var(--amber-b)" },
};

export default function LostSales() {
  const [resolved, setResolved] = useState<Record<string, "applied" | "dismissed">>({});
  const open = LOSSES.filter((l) => !resolved[l.id]);

  const totalLostWk = useMemo(() => open.reduce((a, l) => a + l.lostWk, 0), [open]);
  const storesFlagged = useMemo(() => new Set(open.map((l) => l.store)).size, [open]);
  const cadenceCount = open.filter((l) => l.cadence).length;
  const highCount = open.filter((l) => l.conf === "high").length;

  function apply(id: string) { setResolved((r) => ({ ...r, [id]: "applied" })); }
  function dismiss(id: string) { setResolved((r) => ({ ...r, [id]: "dismissed" })); }
  function applyAllHigh() {
    setResolved((r) => {
      const n = { ...r };
      for (const l of LOSSES) if (l.conf === "high" && !n[l.id]) n[l.id] = "applied";
      return n;
    });
  }

  return (
    <div className="losts">
      <div className="panel intro">
        <div className="itxt">
          The mirror of waste. Waste is baking too much; <b>lost sales is selling out early</b> and turning demand away —
          invisible on the reports because retailers only send what <i>sold</i>, never what someone wanted and couldn&apos;t get.
          The engine flags each likely sellout and sizes the fix. The service dial decides how hard we lean against it.
        </div>
      </div>

      {/* Network strip */}
      <div className="strip">
        <div className="tile">
          <div className="tn">{totalLostWk}<span className="u"> units/wk</span></div>
          <div className="tl">Estimated lost sales</div>
        </div>
        <div className="tile">
          <div className="tn">{storesFlagged}</div>
          <div className="tl">Stores flagged</div>
        </div>
        <div className="tile">
          <div className="tn dim">$ —</div>
          <div className="tl">Lost revenue / wk · lights up with the cost feed</div>
        </div>
        <div className="tile">
          <div className="tn amber">{cadenceCount}</div>
          <div className="tl">Structural — 2-delivery-a-week runs</div>
        </div>
      </div>

      {/* Canberra structural banner */}
      {cadenceCount > 0 && (
        <div className="banner">
          <div className="bh">Canberra runs on 2 deliveries a week</div>
          <div className="bt">
            With only Mon &amp; Thu drops, a good weekend empties the shelf days before the next delivery — the biggest
            structural stockout risk in the network. Lifting the delivered quantity helps, but the real fix is a cadence
            question: is a third Canberra run worth it? Flagged here so it&apos;s a decision, not a silent loss.
          </div>
        </div>
      )}

      {/* Bulk action */}
      <div className="bulk">
        <div className="section-h"><span className="tick" />Sellouts to fix{open.length ? <span className="cnt">{open.length}</span> : null}</div>
        {highCount > 0 && (
          <button className="applyall" onClick={applyAllHigh}>Apply all {highCount} high-confidence fixes</button>
        )}
      </div>

      {/* Exception cards */}
      <div className="cards">
        {open.length === 0 && (
          <div className="allclear">
            <div className="ac-h">All caught up</div>
            <div className="ac-t">Every flagged sellout has been actioned. New ones surface here as the engine detects them.</div>
          </div>
        )}
        {open.map((l) => (
          <div className={`lc${l.conf === "medium" ? " amber" : ""}`} key={l.id}>
            <div className="lc-top">
              <span className="lc-title">{l.store}</span>
              <span className="lc-conf" style={{ background: CONF_META[l.conf].b, color: CONF_META[l.conf].c }}>{CONF_META[l.conf].label}</span>
              <span className="lc-risk">~{l.lostWk} units/wk lost</span>
            </div>
            <div className="lc-sub">{l.product} · {l.day} · {l.retailer} · {l.region}</div>
            <div className="lc-pattern">{l.pattern}</div>
            <div className="lc-fix">
              <span className="lbl">Suggested fix</span>
              <span className="fixline">
                {l.day} {l.product.toLowerCase()} <b>{l.current} → {l.suggested}</b>
                <span className="delta"> +{l.suggested - l.current}</span>
                {l.cadence && <span className="orcad"> · or add a third weekly run</span>}
              </span>
            </div>
            <div className="lc-btns">
              <button className="btn approve" onClick={() => apply(l.id)}>Apply fix</button>
              <button className="btn" onClick={() => dismiss(l.id)}>Dismiss</button>
            </div>
          </div>
        ))}
      </div>

      {/* Applied log */}
      {Object.keys(resolved).length > 0 && (
        <div className="applied">
          <div className="section-h" style={{ marginTop: 8 }}><span className="tick" />Actioned this session</div>
          <div className="panel" style={{ padding: 0 }}>
            {LOSSES.filter((l) => resolved[l.id]).map((l, i) => (
              <div className="arow" key={l.id} style={{ borderTop: i ? "1px solid var(--line2)" : undefined }}>
                <span className="a-check" style={{ color: resolved[l.id] === "applied" ? "var(--green-t)" : "var(--muted)" }}>
                  {resolved[l.id] === "applied" ? "✓" : "○"}
                </span>
                <span className="a-store">{l.store}</span>
                <span className="a-prod">{l.product} · {l.day}</span>
                <span className="a-res">{resolved[l.id] === "applied" ? `${l.current} → ${l.suggested}` : "dismissed"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="foot" style={{ marginTop: 16 }}>
        Representative of the sellout patterns the engine surfaces from delivered-vs-sold and sellout timing. Figures fill
        in from live detection; lost revenue turns on when the cost feed lands.
      </div>

      <style>{`
        .losts .intro{margin-bottom:16px}
        .losts .intro .itxt{font-size:14.5px;line-height:1.65;color:var(--ink2)}
        .losts .intro b{color:var(--ink);font-weight:600}
        .losts .strip{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}
        .losts .tile{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px}
        .losts .tn{font-family:var(--serif);font-size:30px;font-weight:600;line-height:1;letter-spacing:-.6px;font-variant-numeric:tabular-nums}
        .losts .tn .u{font-size:14px;color:var(--muted);font-family:var(--sans);font-weight:500}
        .losts .tn.dim{color:var(--muted)}
        .losts .tn.amber{color:var(--amber-t)}
        .losts .tl{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.4}

        .losts .banner{background:var(--amber-b);border:1px solid #e9cfa0;border-radius:var(--r);padding:16px 20px;margin-bottom:18px}
        .losts .banner .bh{font-family:var(--serif);font-size:16px;font-weight:600;color:var(--amber-t)}
        .losts .banner .bt{font-size:13.5px;color:#7c5308;line-height:1.6;margin-top:6px}

        .losts .bulk{display:flex;align-items:center;gap:14px;margin-bottom:12px}
        .losts .cnt{background:var(--red);color:#fff;border-radius:999px;font-size:11px;padding:1px 8px;font-weight:700;margin-left:9px}
        .losts .applyall{margin-left:auto;background:var(--green);border:1px solid var(--green);color:#fff;border-radius:10px;padding:9px 15px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
        .losts .applyall:hover{background:#548050}

        .losts .cards{display:grid;grid-template-columns:1fr 1fr;gap:14px}
        .losts .lc{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:18px 20px;position:relative;overflow:hidden}
        .losts .lc::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--red)}
        .losts .lc.amber::before{background:var(--amber)}
        .losts .lc-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:7px}
        .losts .lc-title{font-family:var(--serif);font-weight:600;font-size:16px;letter-spacing:-.2px}
        .losts .lc-conf{font-size:10.5px;font-weight:700;padding:3px 8px;border-radius:999px;white-space:nowrap}
        .losts .lc-risk{margin-left:auto;font-size:12px;color:var(--red-t);font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
        .losts .lc-sub{font-size:12.5px;color:var(--muted);margin-bottom:9px}
        .losts .lc-pattern{font-size:13.5px;color:var(--ink2);line-height:1.55;margin-bottom:11px}
        .losts .lc-fix{font-size:14px;padding:11px 13px;background:var(--surface);border:1px solid var(--line2);border-radius:10px;border-left:2px solid var(--crust);margin-bottom:13px}
        .losts .lc-fix .lbl{font-size:10.5px;letter-spacing:1px;text-transform:uppercase;color:var(--crust-deep);font-weight:700;display:block;margin-bottom:3px}
        .losts .fixline{font-size:13.5px;color:var(--ink2)}
        .losts .fixline b{color:var(--ink);font-weight:700;font-variant-numeric:tabular-nums}
        .losts .delta{color:var(--green-t);font-weight:700}
        .losts .orcad{color:var(--muted);font-weight:500}
        .losts .lc-btns{display:flex;gap:8px}
        .losts .btn{border:1px solid var(--line);background:var(--card);border-radius:var(--rc);padding:8px 15px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;color:var(--ink)}
        .losts .btn:hover{background:#f6f0e6}
        .losts .btn.approve{background:var(--green);border-color:var(--green);color:#fff}
        .losts .btn.approve:hover{background:#548050}

        .losts .allclear{grid-column:span 2;background:var(--green-b);border:1px solid #cfe0c6;border-radius:var(--r);padding:22px}
        .losts .ac-h{font-family:var(--serif);font-size:17px;font-weight:600;color:var(--green-t)}
        .losts .ac-t{font-size:13.5px;color:#4a6a44;margin-top:5px;line-height:1.55}

        .losts .applied{margin-top:18px}
        .losts .arow{display:flex;align-items:center;gap:12px;padding:11px 16px;font-size:13px}
        .losts .a-check{font-weight:700;width:14px}
        .losts .a-store{font-weight:600}
        .losts .a-prod{color:var(--muted)}
        .losts .a-res{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--ink2);font-weight:600}

        @media (max-width:1080px){ .losts .strip{grid-template-columns:1fr 1fr} .losts .cards{grid-template-columns:1fr} .losts .allclear{grid-column:span 1} }
      `}</style>
    </div>
  );
}
