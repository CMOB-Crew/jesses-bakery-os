"use client";
import Link from "next/link";
import type { Launches, LaunchCohort, LiveLaunch } from "@/lib/queries";
import StatusTag from "@/components/StatusTag";

/* ------------------------------------------------------------------ *
 * Launches — new-store rollouts, tracked from before they go live so a
 * rollout never slips through. Two lists, both live from the store master:
 *   Coming up   — added, planned go-live, not yet supplied (go_live_at set).
 *   Live now    — onboarded in the last 6 weeks, tracked on units/store/day.
 * A launch appears here automatically the moment it is added or flipped
 * live; nothing to remember to file.
 * ------------------------------------------------------------------ */

const RETAILER: Record<string, string> = {
  woolworths: "Woolworths", coles: "Coles", harris_farm: "Harris Farm", invoice: "Invoice",
};
const retailerLabel = (r: string) => RETAILER[r] ?? r;
const sizeLabel = (s: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : "Unsized");

function fmtDate(d: Date | string | null): string {
  if (!d) return "date TBC";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (isNaN(dt.getTime())) return "date TBC";
  return dt.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}
function whenLive(days: number | null): string {
  if (days == null) return "date to confirm";
  if (days < 0) return "go-live passed — confirm supply started";
  if (days === 0) return "goes live today";
  if (days <= 7) return `in ${days} day${days === 1 ? "" : "s"}`;
  const wk = Math.round(days / 7);
  return `in ~${wk} week${wk === 1 ? "" : "s"}`;
}
const num = (n: number) => n.toLocaleString("en-AU");
const sellThrough = (l: LiveLaunch): number | null =>
  l.total_sent > 0 ? Math.round((1000 * l.total_sold) / l.total_sent) / 10 : null;

export default function LaunchesView({ launches }: { launches: Launches }) {
  const { cohorts, live, pipelineCount, liveCount } = launches;
  const nextLive = cohorts.find((c) => c.go_live_at)?.go_live_at ?? null;

  return (
    <div className="lau">
      <div className="panel intro">
        <div className="itxt">
          Every new store rollout, tracked from the day it&apos;s added. <b>Coming up</b> is the stores you&apos;ve lined
          up but aren&apos;t supplying yet; <b>Live now</b> is anything gone live in the last 6 weeks, watched on the one
          number that matters early — <b>units per store, per day</b>. It fills in on its own as stores are added and
          flipped live, so a launch never slips through the cracks.
        </div>
      </div>

      <div className="strip">
        <div className="tile"><div className="tn">{pipelineCount}</div><div className="tl">Coming up · awaiting supply</div></div>
        <div className="tile"><div className="tn green">{liveCount}</div><div className="tl">Live now · first 6 weeks</div></div>
        <div className="tile"><div className="tn">{nextLive ? fmtDate(nextLive) : "—"}</div><div className="tl">Next planned go-live</div></div>
      </div>

      <div className="section-h"><span className="tick" />Coming up</div>
      {cohorts.length === 0 ? (
        <div className="panel empty">
          Nothing in the pipeline right now. When you add a new store on <Link href="/new-store">New store</Link> and set a
          planned go-live date, its rollout shows up here — and stays out of the Archive so it&apos;s never mistaken for a
          dormant store.
        </div>
      ) : (
        <div className="cohorts">
          {cohorts.map((c) => <Cohort key={c.key} c={c} />)}
        </div>
      )}

      <div className="section-h" style={{ marginTop: 26 }}><span className="tick" />Live now — first 6 weeks</div>
      {live.length === 0 ? (
        <div className="panel empty">
          Nothing has gone live in the last 6 weeks. The moment you flip a new store live (set it active with its go-live
          date), it lands here for its first 6 weeks — <b>days live</b>, <b>units per store per day</b>, sell-through and
          waste — then graduates to the normal store list. Per-day detail sharpens as the daily sales feed comes online.
        </div>
      ) : (
        <div className="live">
          {live.map((l) => <LiveRow key={l.store_id} l={l} />)}
        </div>
      )}

      <div className="panel next">
        <div className="nh">New products are next</div>
        <div className="nt">
          Same idea for a new product launch — track it separately from day one (units moved, sell-through, which stores
          took it). The next step is tagging a product&apos;s launch date; the Harris Farm Choc Babka is first in line once
          its product code lands.
        </div>
      </div>

      <div className="foot">
        Live from the store master. A store joins <b>Coming up</b> when it&apos;s added with a planned go-live and no supply
        yet; it moves to <b>Live now</b> when it&apos;s flipped active with a go-live date, and leaves after 6 weeks. Units
        per store per day is this week&apos;s units spread over the days observed (~) until the daily feed lands.
      </div>

      <style>{`
        .lau .intro{margin-bottom:16px}
        .lau .intro .itxt{font-size:14.5px;line-height:1.65;color:var(--ink2)}
        .lau .intro b{color:var(--ink);font-weight:600}
        .lau .panel{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px}
        .lau .strip{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:22px}
        .lau .tile{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:16px 18px}
        .lau .tn{font-family:var(--serif);font-size:30px;font-weight:600;line-height:1.05;letter-spacing:-.5px;font-variant-numeric:tabular-nums}
        .lau .tn.green{color:var(--green-t)}
        .lau .tl{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.4}

        .lau .empty{font-size:14px;line-height:1.6;color:var(--ink2);margin-top:2px}
        .lau .empty a{color:var(--crust-deep,var(--espresso));font-weight:600}

        .lau .cohorts{display:flex;flex-direction:column;gap:14px}
        .lau .co{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);overflow:hidden}
        .lau .co-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding:15px 18px 13px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#fffaf0,var(--card))}
        .lau .co-title{font-family:var(--serif);font-size:16.5px;font-weight:600}
        .lau .co-when{font-size:12.5px;font-weight:700;color:#9a6414;background:#f6ead2;border-radius:999px;padding:3px 10px;white-space:nowrap}
        .lau .co-sub{font-size:12.5px;color:var(--muted);margin-left:auto}
        .lau .co-rows{display:flex;flex-direction:column}
        .lau .sr{display:flex;align-items:center;gap:14px;padding:12px 18px;border-top:1px solid var(--line2)}
        .lau .sr:first-child{border-top:none}
        .lau .sr-name{font-weight:600;font-size:14.5px;min-width:0}
        .lau .sr-meta{font-size:12px;color:var(--muted);margin-top:2px}
        .lau .sr-code{font-size:12px;color:var(--ink2);background:var(--line2);border-radius:6px;padding:2px 8px;font-variant-numeric:tabular-nums;white-space:nowrap}
        .lau .sr-pill{margin-left:auto;font-size:11px;font-weight:700;color:var(--muted);background:var(--line2);border-radius:999px;padding:4px 11px;white-space:nowrap}

        .lau .live{display:flex;flex-direction:column;gap:12px}
        .lau .lr{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:15px 18px;display:flex;gap:18px;align-items:center;flex-wrap:wrap}
        .lau .lr-main{min-width:180px;flex:1}
        .lau .lr-name{font-family:var(--serif);font-size:16px;font-weight:600}
        .lau .lr-meta{font-size:12.5px;color:var(--muted);margin-top:3px}
        .lau .lr-mets{display:flex;gap:22px;flex-wrap:wrap}
        .lau .met{text-align:right;min-width:64px}
        .lau .met .mv{font-size:17px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.1}
        .lau .met .ml{font-size:10.5px;color:var(--muted);margin-top:3px;text-transform:uppercase;letter-spacing:.03em}
        .lau .lr-act{display:flex;flex-direction:column;align-items:flex-end;gap:8px}
        .lau .lr-open{font-size:13px;font-weight:600;color:var(--crust-deep,var(--espresso))}

        .lau .next{margin-top:22px;border-style:dashed}
        .lau .next .nh{font-family:var(--serif);font-size:15px;font-weight:600;margin-bottom:5px}
        .lau .next .nt{font-size:13.5px;line-height:1.6;color:var(--ink2)}

        .lau .foot{font-size:12px;color:var(--muted);line-height:1.55;margin-top:18px}
        .lau .foot b{color:var(--ink2);font-weight:600}

        @media (max-width:1080px){ .lau .strip{grid-template-columns:1fr 1fr} .lau .co-sub{margin-left:0;width:100%} }
      `}</style>
    </div>
  );
}

function Cohort({ c }: { c: LaunchCohort }) {
  const n = c.stores.length;
  const days = c.stores.find((s) => s.days_to_live != null)?.days_to_live ?? null;
  const retailers = [...new Set(c.stores.map((s) => retailerLabel(s.retailer)))].join(", ");
  return (
    <div className="co">
      <div className="co-head">
        <span className="co-title">{n} {n === 1 ? "store" : "stores"} · {c.region ?? "Unassigned"}</span>
        <span className="co-when">Go-live {fmtDate(c.go_live_at)} · {whenLive(days)}</span>
        <span className="co-sub">{retailers} · supply not started</span>
      </div>
      <div className="co-rows">
        {c.stores.map((s) => (
          <div className="sr" key={s.store_id}>
            <div className="sr-main">
              <div className="sr-name">{s.name}</div>
              <div className="sr-meta">{retailerLabel(s.retailer)} · {sizeLabel(s.size)}</div>
            </div>
            {s.supplier_code ? <span className="sr-code">{retailerLabel(s.retailer)} loc #{s.supplier_code}</span> : null}
            <span className="sr-pill">Awaiting supply</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LiveRow({ l }: { l: LiveLaunch }) {
  const st = sellThrough(l);
  return (
    <div className="lr">
      <div className="lr-main">
        <div className="lr-name">{l.name}</div>
        <div className="lr-meta">{retailerLabel(l.retailer)} · {l.region ?? "—"} · {sizeLabel(l.size)} · live {fmtDate(l.onboarded_at)}</div>
      </div>
      <div className="lr-mets">
        <div className="met"><div className="mv">{l.days_live ?? "—"}</div><div className="ml">Days live</div></div>
        <div className="met"><div className="mv">{l.units_per_day != null ? `~${num(l.units_per_day)}` : "—"}</div><div className="ml">Units/store/day</div></div>
        <div className="met"><div className="mv">{st != null ? `${st}%` : "—"}</div><div className="ml">Sell-through</div></div>
        <div className="met"><div className="mv">{l.waste_pct != null ? `${l.waste_pct}%` : "—"}</div><div className="ml">Waste</div></div>
      </div>
      <div className="lr-act">
        {l.total_sent > 0 || l.total_sold > 0 ? <StatusTag status={l.status} /> : <StatusTag status="nodata" />}
        <Link href={`/store/${l.store_id}`} className="lr-open">Open store →</Link>
      </div>
    </div>
  );
}
