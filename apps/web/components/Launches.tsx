"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Launches, LaunchCohort, LaunchTrial, LiveLaunch, PipelineStore, ProductLaunch, TrialVerdict } from "@/lib/queries";
import StatusTag from "@/components/StatusTag";
import { markStoreLive } from "@/app/launches/actions";

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
const titleCase = (t: string) => (t || "").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

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
// A launch store with no sales feed has sold = 0 for want of data, not for want
// of customers. Returning null keeps it off the scoreboard instead of printing
// a 0% that reads as a failing store.
const sellThrough = (l: LiveLaunch): number | null =>
  l.has_sales_feed !== false && l.total_sent > 0
    ? Math.round((1000 * l.total_sold) / l.total_sent) / 10
    : null;

const VERDICT: Record<TrialVerdict, { label: string; cls: string }> = {
  expand: { label: "Expand", cls: "v-expand" },
  continue: { label: "Continue", cls: "v-continue" },
  modify: { label: "Modify", cls: "v-modify" },
  remove: { label: "Remove", cls: "v-remove" },
  early: { label: "Too early", cls: "v-early" },
};

export default function LaunchesView({ launches, productLaunches = [] }: { launches: Launches; productLaunches?: ProductLaunch[] }) {
  const { cohorts, live, trials = [], pipelineCount, liveCount } = launches;
  const nextLive = cohorts.find((c) => c.go_live_at)?.go_live_at ?? null;

  return (
    <div className="lau">
      <div className="panel intro">
        <div className="itxt">
          Every new store and product launch, tracked from the day it&apos;s added. <b>Coming up</b> is the stores
          you&apos;ve lined up but aren&apos;t supplying yet; <b>Live now</b> and <b>New products</b> are anything gone live
          in the last 6 weeks — watched early on <b>units per store, per day</b> for a store, and stores-ranging plus units
          sold for a new line. It fills in on its own as launches are added and go live, so none slips through the cracks.
        </div>
      </div>

      <div className="strip">
        <div className="tile"><div className="tn">{pipelineCount}</div><div className="tl">Coming up · awaiting supply</div></div>
        <div className="tile"><div className={`tn${liveCount > 0 ? " green" : " zero"}`}>{liveCount}</div><div className="tl">Live now · first 6 weeks</div></div>
        <div className="tile"><div className="tn">{nextLive ? fmtDate(nextLive) : "—"}</div><div className="tl">Next planned go-live</div></div>
      </div>

      <div className="section-h"><span className="tick" />Trial performance<span className="sh-note">expand · continue · modify · remove, after ~4 weeks</span></div>
      {trials.length === 0 ? (
        <div className="panel empty slim">
          No trials to report yet. The moment a rollout goes live, its stores group into a trial here — units per store per
          day, sell-through, waste and week-on-week growth — and after about four weeks it calls whether to <b>expand</b>,
          <b> continue</b>, <b>modify</b> or <b>remove</b>.
        </div>
      ) : (
        <div className="trials">
          {trials.map((t) => <TrialCard key={t.key} t={t} />)}
        </div>
      )}

      <div className="section-h" style={{ marginTop: 26 }}><span className="tick" />Coming up<Link prefetch={false} href="/new-store" className="add-launch">+ New store launch</Link></div>
      {cohorts.length === 0 ? (
        <div className="panel empty">
          Nothing in the pipeline right now. When you add a new store on <Link prefetch={false} href="/new-store">New store</Link> and set a
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
        <div className="panel empty slim">
          Nothing live in the last 6 weeks yet. Flip a store live and it tracks here for 6 weeks — days live, units per
          store per day, sell-through and waste.
        </div>
      ) : (
        <div className="live">
          {live.map((l) => <LiveRow key={l.store_id} l={l} />)}
        </div>
      )}

      <div className="section-h" style={{ marginTop: 26 }}><span className="tick" />New products — first 6 weeks<Link prefetch={false} href="/products" className="add-launch">+ New product launch</Link></div>
      {productLaunches.length === 0 ? (
        <div className="panel empty slim">
          No product launches tracked yet. Tag a line&apos;s launch date on <Link prefetch={false} href="/products">Products</Link> and it
          tracks here for 6 weeks — stores ranging it, units sold, sell-through and waste — with an <b>Expand / Continue /
          Modify / Remove</b> call once it&apos;s had time to prove out. (Harris Farm Choc Babka once its code lands.)
        </div>
      ) : (
        <div className="live">
          {productLaunches.map((p) => <ProductRow key={p.product_id} p={p} />)}
        </div>
      )}

      <div className="foot">
        Live from the store master and product ledger. A store joins <b>Coming up</b> when it&apos;s added with a planned
        go-live and no supply yet, moves to <b>Live now</b> when it&apos;s flipped active with a go-live date, and leaves
        after 6 weeks; a product joins <b>New products</b> when its launch date is set. Units per store per day is this
        week&apos;s units spread over the days observed (~) until the daily feed lands.
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
        .lau .tn.zero{color:var(--muted)}
        .lau .tl{font-size:12px;color:var(--muted);margin-top:8px;line-height:1.4}

        .lau .section-h{display:flex;align-items:center}
        .lau .add-launch{margin-left:auto;font-size:12px;font-weight:600;color:var(--crust-deep,var(--espresso));border:1px solid var(--line);background:var(--card);border-radius:8px;padding:5px 11px;text-decoration:none}
        .lau .add-launch:hover{background:#f6f0e6}
        .lau .empty{font-size:14px;line-height:1.6;color:var(--ink2);margin-top:2px}
        .lau .empty.slim{font-size:13px;line-height:1.55;color:var(--muted);padding:13px 18px}
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
        .lau .sr-pill{font-size:11px;font-weight:700;color:var(--muted);background:var(--line2);border-radius:999px;padding:4px 11px;white-space:nowrap}
        .lau .sr-act{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
        .lau .sr-live{border:1px solid var(--line);background:var(--card);color:var(--crust-deep,var(--espresso));border-radius:8px;padding:6px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
        .lau .sr-live:hover{background:#f6f0e6}
        .lau .sr-date{border:1px solid var(--line);border-radius:8px;padding:6px 9px;font-size:12.5px;font-family:inherit;background:var(--surface,var(--card));color:var(--ink)}
        .lau .sr-go{border:none;background:var(--green,#557a4f);color:#fff;border-radius:8px;padding:7px 12px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
        .lau .sr-go:disabled{opacity:.6;cursor:default}
        .lau .sr-cancel{border:1px solid var(--line);background:var(--card);color:var(--muted);border-radius:8px;padding:7px 11px;font-size:12.5px;font-weight:600;cursor:pointer;font-family:inherit}
        .lau .sr-err{font-size:11.5px;color:var(--red-t,#a4372a);width:100%;text-align:right}

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
        .lau .pr-sold{font-size:12px;font-weight:700;color:var(--ink2);background:var(--line2);border-radius:999px;padding:4px 10px;white-space:nowrap}
        .lau .pr-reason{flex-basis:100%;width:100%;margin-top:4px;padding-top:11px;border-top:1px solid var(--line2);font-size:12.5px;color:var(--ink2);line-height:1.5}
        .lau .pr-reason b{color:var(--ink);font-weight:600}

        .lau .sh-note{margin-left:10px;font-size:12px;color:var(--muted);font-weight:400}
        .lau .met .mv.up{color:var(--green-t)}
        .lau .met .mv.down{color:var(--red-t,#a4372a)}

        .lau .trials{display:flex;flex-direction:column;gap:12px;margin-top:2px}
        .lau .tc{background:var(--card);border:1px solid var(--line);border-radius:var(--r);box-shadow:var(--sh);padding:15px 18px}
        .lau .tc-head{display:flex;align-items:center;gap:11px;flex-wrap:wrap;margin-bottom:13px}
        .lau .tc-title{font-family:var(--serif);font-size:16.5px;font-weight:600}
        .lau .tc-sub{font-size:12.5px;color:var(--muted);margin-left:auto}
        .lau .tc-part{color:var(--amber-t)}
        .lau .tc-badge{font-size:11.5px;font-weight:700;letter-spacing:.02em;border-radius:999px;padding:4px 12px;text-transform:uppercase}
        .lau .tc-badge.v-expand{color:#2f6b34;background:#e3efd9}
        .lau .tc-badge.v-continue{color:#2b5573;background:#dfeaf3}
        .lau .tc-badge.v-modify{color:#8a5714;background:#f6ead2}
        .lau .tc-badge.v-remove{color:#a4372a;background:#f3ddd8}
        .lau .tc-badge.v-early{color:var(--muted);background:var(--line2)}
        .lau .tc-mets{display:flex;gap:26px;flex-wrap:wrap}
        .lau .tc-reason{margin-top:13px;padding-top:11px;border-top:1px solid var(--line2);font-size:12.5px;color:var(--ink2);line-height:1.5}

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

function TrialCard({ t }: { t: LaunchTrial }) {
  const v = VERDICT[t.verdict];
  const growth =
    t.salesGrowth == null ? "—" : `${t.salesGrowth >= 0 ? "▲" : "▼"} ${Math.abs(t.salesGrowth)}%`;
  return (
    <div className="tc">
      <div className="tc-head">
        <span className="tc-title">{t.label}</span>
        <span className={`tc-badge ${v.cls}`}>{v.label}</span>
        <span className="tc-sub">
          {t.storeCount} {t.storeCount === 1 ? "store" : "stores"} · {t.retailers || "—"} · {t.weeksLive} {t.weeksLive === 1 ? "week" : "weeks"} in
          {t.measuredStores < t.storeCount && (
            <span className="tc-part">
              {t.measuredStores === 0
                ? " · no sales feed yet"
                : ` · read from the ${t.measuredStores} that report sales`}
            </span>
          )}
        </span>
      </div>
      <div className="tc-mets">
        <div className="met"><div className="mv">{t.storeCount}</div><div className="ml">Stores</div></div>
        <div className="met"><div className="mv">{t.unitsPerStorePerDay != null ? `~${num(t.unitsPerStorePerDay)}` : "—"}</div><div className="ml">Units/store/day</div></div>
        <div className="met"><div className="mv">{t.sellThrough != null ? `${t.sellThrough}%` : "—"}</div><div className="ml">Sell-through</div></div>
        <div className="met"><div className="mv">{t.wastePct != null ? `${t.wastePct}%` : "—"}</div><div className="ml">Waste</div></div>
        <div className="met"><div className={`mv${t.salesGrowth == null ? "" : t.salesGrowth >= 0 ? " up" : " down"}`}>{growth}</div><div className="ml">Sales growth</div></div>
        <div className="met"><div className="mv">{t.hasData ? `${t.growingStores}/${t.measuredStores}` : "—"}</div><div className="ml">Holding / growing</div></div>
      </div>
      <div className="tc-reason">{t.verdictReason}</div>
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
        <span className="co-sub">{retailers}</span>
      </div>
      <div className="co-rows">
        {c.stores.map((s) => (
          <div className="sr" key={s.store_id}>
            <div className="sr-main">
              <div className="sr-name">{s.name}</div>
              <div className="sr-meta">{retailerLabel(s.retailer)} · {sizeLabel(s.size)}</div>
            </div>
            {s.supplier_code ? <span className="sr-code">{retailerLabel(s.retailer)} loc #{s.supplier_code}</span> : null}
            <PipelineRowActions store={s} />
          </div>
        ))}
      </div>
    </div>
  );
}

function PipelineRowActions({ store }: { store: PipelineStore }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [date, setDate] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function go() {
    setErr(null);
    start(async () => {
      const res = await markStoreLive(store.store_id, date || undefined);
      if (res.ok) { setConfirming(false); router.refresh(); }
      else setErr(res.error);
    });
  }

  if (!confirming) {
    return (
      <div className="sr-act">
        <span className="sr-pill">Awaiting supply</span>
        <button className="sr-live" onClick={() => setConfirming(true)}>Mark live</button>
      </div>
    );
  }
  return (
    <div className="sr-act">
      <input type="date" className="sr-date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Go-live date (defaults to today)" />
      <button className="sr-go" onClick={go} disabled={pending}>{pending ? "Saving…" : "Confirm live"}</button>
      <button className="sr-cancel" onClick={() => { setConfirming(false); setErr(null); }} disabled={pending}>Cancel</button>
      {err ? <span className="sr-err">{err}</span> : null}
    </div>
  );
}

function ProductRow({ p }: { p: ProductLaunch }) {
  const noData = p.sent === 0 && p.sold === 0;
  const v = VERDICT[p.verdict];
  return (
    <div className="lr">
      <div className="lr-main">
        <div className="lr-name">{p.name} <span className={`tc-badge ${v.cls}`} style={{ marginLeft: 6, verticalAlign: "middle" }}>{v.label}</span></div>
        <div className="lr-meta">{titleCase(p.category)} · launched {fmtDate(p.launched_at)} · {p.stores} {p.stores === 1 ? "store" : "stores"} ranging</div>
      </div>
      <div className="lr-mets">
        <div className="met"><div className="mv">{p.days_since ?? "—"}</div><div className="ml">Days live</div></div>
        <div className="met"><div className="mv">{p.units_per_day != null ? `~${num(p.units_per_day)}` : "—"}</div><div className="ml">Units/store/day</div></div>
        <div className="met"><div className="mv">{p.sell_through != null ? `${p.sell_through}%` : "—"}</div><div className="ml">Sell-through</div></div>
        <div className="met"><div className="mv">{p.waste_pct != null ? `${p.waste_pct}%` : "—"}</div><div className="ml">Waste</div></div>
      </div>
      <div className="lr-act">
        {noData ? <StatusTag status="nodata" /> : <span className="pr-sold">{num(p.sold)} sold/wk</span>}
        <Link prefetch={false} href="/products" className="lr-open">Open products →</Link>
      </div>
      <div className="pr-reason"><b>{v.label}</b> — {p.verdictReason}</div>
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
        <Link prefetch={false} href={`/store/${l.store_id}`} className="lr-open">Open store →</Link>
      </div>
    </div>
  );
}
