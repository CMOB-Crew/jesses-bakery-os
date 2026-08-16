"use client";
import { useMemo, useState } from "react";
import type { ArchivedStore } from "@/lib/queries";

/* ------------------------------------------------------------------ *
 * Store archive — inactive stores, kept viewable. Live from the store
 * master (active = false). Warm/cold is derived from how recently the
 * store last had sales (no archive-reason metadata in the schema yet, so
 * recency is the honest signal). Pairs with New store as the lifecycle.
 * ------------------------------------------------------------------ */

type Filter = "all" | "warm" | "cold";
const WARM_DAYS = 60;

function ago(d: number | null): string {
  if (d === null) return "no recorded sales";
  if (d <= 10) return "this week";
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  if (d < 365) return `${Math.round(d / 30)} months ago`;
  return `${(d / 365).toFixed(1)} years ago`;
}
const sizeLabel = (s: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : "Unsized");

export default function StoreArchive({ stores }: { stores: ArchivedStore[] }) {
  const [filter, setFilter] = useState<Filter>("all");

  const rows = useMemo(() => stores.map((s) => ({
    ...s, warm: s.days_since !== null && s.days_since <= WARM_DAYS,
  })), [stores]);

  const warm = rows.filter((r) => r.warm).length;
  const cold = rows.length - warm;
  const oldest = rows.reduce((m, r) => Math.max(m, r.days_since ?? 0), 0);
  const shown = rows.filter((r) => filter === "all" || (filter === "warm" ? r.warm : !r.warm));

  if (!stores.length) {
    return (
      <div className="arch">
        <div className="panel intro">
          <div className="itxt">
            Stores that go quiet aren&apos;t deleted — they&apos;re archived and kept fully viewable, so when a retailer asks
            to re-range one its whole history is right here. Nothing archived right now; deactivated stores appear here
            automatically.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="arch">
      <div className="panel intro">
        <div className="itxt">
          Stores that go quiet aren&apos;t deleted — they&apos;re <b>archived and kept fully viewable</b>. When a retailer
          asks to re-range one, its whole history is right here and it comes back in a click. <b>Warm</b> = sold within the
          last {WARM_DAYS} days, likely to return; <b>cold</b> = long dormant. Nothing lost, nothing stale in the live counts.
        </div>
      </div>

      <div className="strip">
        <div className="tile"><div className="tn">{rows.length}</div><div className="tl">Archived stores</div></div>
        <div className="tile"><div className="tn green">{warm}</div><div className="tl">Warm · re-range candidates</div></div>
        <div className="tile"><div className="tn dim">{cold}</div><div className="tl">Cold · long dormant</div></div>
        <div className="tile"><div className="tn">{oldest ? ago(oldest).replace(" ago", "") : "—"}</div><div className="tl">Oldest in the archive</div></div>
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
          <div className={`ac${a.warm ? " warm" : ""}`} key={a.store_id}>
            <div className="ac-main">
              <div className="ac-top">
                <span className="ac-name">{a.name}</span>
                <span className={`ac-tag ${a.warm ? "warm" : "cold"}`}>{a.warm ? "● Warm" : "● Cold"}</span>
              </div>
              <div className="ac-meta">{a.retailer} · {a.region ?? "—"} · {sizeLabel(a.size)} · last active {ago(a.days_since)}</div>
              <div className="ac-note">
                {a.warm
                  ? "Recent sales history — a strong re-range candidate when the retailer reopens the range."
                  : a.days_since === null
                  ? "No sales on record. Confirm status with the retailer before re-ranging."
                  : "Long dormant. Kept for history; reactivate only on a clear ask."}
              </div>
            </div>
            <div className="ac-act">
              <button className="hist">View history</button>
              <button className={`react${a.warm ? " on" : ""}`}>Re-range</button>
            </div>
          </div>
        ))}
      </div>

      <div className="foot" style={{ marginTop: 16 }}>
        Live from the store master (active = false). Warm/cold is read from the last recorded sale; re-range opens New
        store pre-filled from the store&apos;s history. Archived stays out of the live network counts but never leaves the record.
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
