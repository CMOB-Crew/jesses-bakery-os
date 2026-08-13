"use client";
import { useMemo, useState } from "react";

/* ------------------------------------------------------------------ *
 * Store archive — Simona: inactive stores shouldn't be deleted, they
 * should be tagged and stay viewable. When a retailer asks to re-range
 * one, the full history is right there and it comes back in a click.
 * "Cold vs warm" — warm = strong history / likely to return; cold =
 * long dormant. Pairs with New store as the other end of the lifecycle.
 *
 * Front-end prototype; the archive state + history are the engine's.
 * ------------------------------------------------------------------ */

type Reason = "Deranged by retailer" | "Store closed" | "Paused — refit" | "Deranged — slow sales";
type Arch = {
  name: string; retailer: string; region: string; size: string;
  reason: Reason; since: string; months: number; warm: boolean; peak: number; note: string;
};

const ARCHIVED: Arch[] = [
  { name: "Coles Chatswood Chase", retailer: "Coles", region: "North Shore", size: "Large",
    reason: "Deranged by retailer", since: "6 weeks ago", months: 1.5, warm: true, peak: 88,
    note: "Strong history, deranged in a category reset. Retailer reviewing a spring re-range." },
  { name: "Woolworths Metro Wynyard", retailer: "Woolworths", region: "Eastern Suburbs", size: "Small",
    reason: "Paused — refit", since: "3 weeks ago", months: 0.75, warm: true, peak: 82,
    note: "Store refit — expected to reopen in ~4 weeks. Hold the ranging, don't rebuild." },
  { name: "Woolworths Neutral Bay", retailer: "Woolworths", region: "North Shore", size: "Medium",
    reason: "Deranged by retailer", since: "10 weeks ago", months: 2.5, warm: true, peak: 85,
    note: "Good sell-through history; a likely return when the retailer reopens the range." },
  { name: "Harris Farm Bondi", retailer: "Harris Farm", region: "Eastern Suburbs", size: "Small",
    reason: "Deranged — slow sales", since: "5 months ago", months: 5, warm: false, peak: 64,
    note: "Never found its level — low sell-through throughout. Cold; reactivate only on a clear ask." },
  { name: "Coles Town Hall", retailer: "Coles", region: "Inner West", size: "Medium",
    reason: "Store closed", since: "8 months ago", months: 8, warm: false, peak: 79,
    note: "Site permanently closed. Kept for history only." },
  { name: "Coles Broadway", retailer: "Coles", region: "Inner West", size: "Medium",
    reason: "Paused — refit", since: "7 months ago", months: 7, warm: false, peak: 71,
    note: "Refit ran long — now cold. Confirm status with the retailer before re-ranging." },
];

type Filter = "all" | "warm" | "cold";

export default function StoreArchive() {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = ARCHIVED.filter((a) => filter === "all" || (filter === "warm" ? a.warm : !a.warm));

  const warm = ARCHIVED.filter((a) => a.warm).length;
  const cold = ARCHIVED.length - warm;
  const oldest = useMemo(() => ARCHIVED.reduce((m, a) => (a.months > m.months ? a : m), ARCHIVED[0]), []);

  return (
    <div className="arch">
      <div className="panel intro">
        <div className="itxt">
          Stores that go quiet aren&apos;t deleted — they&apos;re <b>archived and kept fully viewable</b>. When a retailer
          asks to re-range one, its whole history is right here and it comes back in a click. <b>Warm</b> = strong history,
          likely to return; <b>cold</b> = long dormant. Nothing is ever lost, and nothing stale clutters the live network.
        </div>
      </div>

      <div className="strip">
        <div className="tile"><div className="tn">{ARCHIVED.length}</div><div className="tl">Archived stores</div></div>
        <div className="tile"><div className="tn green">{warm}</div><div className="tl">Warm · re-range candidates</div></div>
        <div className="tile"><div className="tn dim">{cold}</div><div className="tl">Cold · long dormant</div></div>
        <div className="tile"><div className="tn">{oldest.since.replace(" ago", "")}</div><div className="tl">Oldest in the archive</div></div>
      </div>

      <div className="bulk">
        <div className="section-h"><span className="tick" />Archived stores</div>
        <div className="filter">
          {(["all", "warm", "cold"] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
              {f === "all" ? "All" : f === "warm" ? "Warm" : "Cold"}
            </button>
          ))}
        </div>
      </div>

      <div className="list">
        {shown.map((a) => (
          <div className={`ac${a.warm ? " warm" : ""}`} key={a.name}>
            <div className="ac-main">
              <div className="ac-top">
                <span className="ac-name">{a.name}</span>
                <span className={`ac-tag ${a.warm ? "warm" : "cold"}`}>{a.warm ? "● Warm" : "● Cold"}</span>
                <span className="ac-reason">{a.reason}</span>
              </div>
              <div className="ac-meta">{a.retailer} · {a.region} · {a.size} · archived {a.since} · peak sell-through {a.peak}%</div>
              <div className="ac-note">{a.note}</div>
            </div>
            <div className="ac-act">
              <button className="hist">View history</button>
              <button className={`react${a.warm ? " on" : ""}`}>Re-range</button>
            </div>
          </div>
        ))}
      </div>

      <div className="foot" style={{ marginTop: 16 }}>
        Representative. Re-range opens the New store setup pre-filled from the store&apos;s own history, so a returning
        store comes back at the right size and basket rather than from scratch. Archived stays out of the live network
        counts but never leaves the record.
      </div>

      <style>{`
        .arch .intro{margin-bottom:16px}
        .arch .intro .itxt{font-size:14.5px;line-height:1.65;color:var(--ink2)}
        .arch .intro b{color:var(--ink);font-weight:600}
        .arch .strip{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}
        .arch .tile{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px}
        .arch .tn{font-family:var(--serif);font-size:30px;font-weight:600;line-height:1.05;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
        .arch .tn.green{color:var(--green-t)} .arch .tn.dim{color:var(--muted)}
        .arch .tl{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.4}

        .arch .bulk{display:flex;align-items:center;gap:14px;margin-bottom:12px}
        .arch .filter{margin-left:auto;display:flex;border:1px solid var(--line);border-radius:9px;overflow:hidden}
        .arch .filter button{border:none;background:var(--card);padding:7px 15px;font-size:12.5px;font-weight:600;cursor:pointer;color:var(--ink2);font-family:inherit;border-right:1px solid var(--line)}
        .arch .filter button:last-child{border-right:none}
        .arch .filter button.on{background:var(--espresso);color:#f7efdd}

        .arch .list{display:flex;flex-direction:column;gap:12px}
        .arch .ac{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px;display:flex;gap:16px;align-items:flex-start;position:relative;overflow:hidden}
        .arch .ac::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--faint)}
        .arch .ac.warm::before{background:var(--green)}
        .arch .ac-main{flex:1;min-width:0}
        .arch .ac-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px}
        .arch .ac-name{font-family:var(--serif);font-weight:600;font-size:16px}
        .arch .ac-tag{font-size:10.5px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap}
        .arch .ac-tag.warm{background:var(--green-b);color:var(--green-t)}
        .arch .ac-tag.cold{background:var(--line2);color:var(--muted)}
        .arch .ac-reason{font-size:12px;color:var(--amber-t);background:var(--amber-b);padding:3px 9px;border-radius:999px;font-weight:600}
        .arch .ac-meta{font-size:12.5px;color:var(--muted);margin-bottom:7px}
        .arch .ac-note{font-size:13.5px;color:var(--ink2);line-height:1.55}
        .arch .ac-act{display:flex;flex-direction:column;gap:8px;flex:none;width:118px}
        .arch .ac-act button{border-radius:var(--rc);padding:8px 12px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;border:1px solid var(--line);background:var(--card);color:var(--ink)}
        .arch .ac-act .hist:hover{background:#f6f0e6}
        .arch .ac-act .react.on{background:var(--green);border-color:var(--green);color:#fff}
        .arch .ac-act .react.on:hover{background:#548050}
        .arch .ac-act .react:not(.on){color:var(--muted)}

        @media (max-width:1080px){ .arch .strip{grid-template-columns:1fr 1fr} .arch .ac-act{width:auto;flex-direction:row} }
      `}</style>
    </div>
  );
}
