import { withUser } from "@/lib/db";
import Link from "next/link";
import { getNetwork, getRegions, getRecommendations, getAsOf, getFeedStatus, getEngineProjection, getStoreWeek, getStoreRevenueWeek, getAppSettings, getStoreStates, getShelfCapOverrides, getPeakDaySold, getEngineHealth } from "@/lib/queries";
import type { StoreWeek } from "@/lib/queries";
import StatusTag from "@/components/StatusTag";
import RecCard from "@/components/RecCard";
import AskBar from "@/components/AskBar";
import EnginePanel from "@/components/EnginePanel";
import TodayDashboard from "@/components/TodayDashboard";

// Render per request rather than prerendering at build. This is the heaviest
// page (network + regions + engine + store week), and baking it at build time is
// what made deploys flaky when the build-time Supabase was slow. The runtime DB
// is fast and readers are guarded, so dynamic is both reliable and correct here.
export const dynamic = "force-dynamic";

// Sydney, explicitly. The server is UTC, and "2:00am" rendered in UTC for a
// run that happened at 2am Sydney would read 4pm the previous day -- which is
// precisely the confusion the whole engine-clock thread has been about.
function fmtWhen(d: Date | null) {
  if (!d) return "never";
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "short", day: "numeric", month: "short",
    hour: "numeric", minute: "2-digit", timeZone: "Australia/Sydney",
  }).format(new Date(d));
}

function fmtDate(d: Date) {
  return new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short" }).format(new Date(d));
}

export default async function Overview() {
  // The store-week rows are started once and shared. getRecommendations used to
  // fetch the same 265 rows a second time and then run three more per-store
  // lookups, so this page made 14 round trips to Singapore where 10 would do —
  // and on a cold Netlify function that was the difference between rendering
  // and streaming an empty body. Chaining off storesP rather than awaiting it
  // first keeps everything else running in parallel.
  // storesP has to be created INSIDE withUser. Outside it, it opens its own
  // transaction on its own connection and resolves the user separately —
  // which is why v_store_week reported 14,030ms in the trace while every other
  // query on the page reported 10-12.6s. Same request, two connections,
  // competing.
  const [net, regions, recs, asOf, feeds, engine, stores, revMap, settings, states, capOverrides, peakDay, engineHealth] = await withUser(() => {
    const storesP = getStoreWeek();
    return Promise.all([
      getNetwork(), getRegions(), storesP.then((s) => getRecommendations(3, s)), getAsOf(), getFeedStatus(), getEngineProjection(), storesP, getStoreRevenueWeek(), getAppSettings(), getStoreStates(), getShelfCapOverrides(), getPeakDaySold(), getEngineHealth(),
    ]);
  });

  // Per-store revenue as a plain object — a Map doesn't survive the server →
  // client boundary, and the dashboard needs per-store figures to recompute the
  // $ tiles when a state filter is on rather than hiding them.
  const revByStore: Record<string, { rev: number; aur: number | null }> = {};
  for (const [id, r] of revMap) {
    revByStore[id] = { rev: Number(r.revenue_wk) || 0, aur: r.avg_unit_revenue == null ? null : Number(r.avg_unit_revenue) };
  }

  // Simona's per-size waste thresholds (Settings). Null falls back to the defaults
  // in the dashboard until she sets her own.
  const wt = settings.waste_thresholds as { small: number; medium: number; large: number } | undefined;
  const thresholds = wt ?? null;

  // A feed that is LATE gets a badge. A feed that has STOPPED gets a banner,
  // because it is not a fact about that feed — it is a caveat on every number
  // on this page. Fred, 26 Aug: "Coles died 4 Aug and reported Success for
  // three weeks. That's the difference between our system and theirs."
  const late = feeds.find((f) => f.status === "late");
  const stopped = feeds.filter((f) => f.status === "stopped");

  // The blast radius, computed from rows this page already has rather than
  // another round trip: how many stores each dead feed covers, and what share
  // of the week's delivered units they are. Delivered, not sold — sold is
  // exactly the number we have stopped receiving, so measuring the hole with
  // the missing data would report it as zero.
  const sentAll = stores.reduce((a, st) => a + Number(st.total_sent || 0), 0);
  const darkInfo = stopped.map((f) => {
    const mine = stores.filter((st) => st.retailer === f.source);
    const sent = mine.reduce((a, st) => a + Number(st.total_sent || 0), 0);
    return {
      source: f.source,
      days: f.days_behind,
      stores: mine.length,
      sent,
      share: sentAll > 0 ? Math.round((1000 * sent) / sentAll) / 10 : null,
    };
  });
  const darkStores = darkInfo.reduce((a, d) => a + d.stores, 0);
  const darkShare = darkInfo.reduce((a, d) => a + (d.share ?? 0), 0);

  // Network dollar layer (Invoice_Cost). Null until the extract is loaded, so the
  // Overview keeps its "unlocks with the cost feed" placeholders until then.
  let revenue: { salesWk: number; wasteWk: number } | null = null;
  if (revMap.size > 0) {
    let salesWk = 0;
    for (const r of revMap.values()) salesWk += r.revenue_wk;
    // Waste $ is inferred (delivered − sold) valued at each store's unit revenue —
    // the reported `wastage` table is empty in prod, so v_store_revenue_week's
    // waste_revenue_wk reads 0. This matches how waste is inferred everywhere else.
    let wasteWk = 0;
    for (const s of stores) {
      const rev = revMap.get(s.store_id);
      if (rev?.avg_unit_revenue != null) {
        wasteWk += Math.max(0, Number(s.total_sent) - Number(s.total_sold)) * rev.avg_unit_revenue;
      }
    }
    revenue = { salesWk: Math.round(salesWk), wasteWk: Math.round(wasteWk) };
  }

  // Honest status counts. A store is only scored if we can actually see its
  // sales — otherwise it goes in "awaiting feed", not in a colour.
  //
  // This rule has to be IDENTICAL to the one on the Stores list, and for a while
  // it wasn't. Testing only `sent > 0 || sold > 0` let every dark store through:
  // a Coles store is still being delivered to, so it passed, and with migration
  // 027 giving it a NULL waste, jb_status found nothing to fail on and returned
  // green. The Overview read "154 On track" while the Stores list read "Green 1
  // · No data 170" — the same 265 stores, 153 of them called healthy on one page
  // and unmeasurable on the other. The Stores list was right.
  const hasData = (s: StoreWeek) =>
    s.has_sales_feed !== false && (Number(s.total_sent) > 0 || Number(s.total_sold) > 0);
  const eff: Record<"red" | "amber" | "green" | "nodata", number> = { red: 0, amber: 0, green: 0, nodata: 0 };
  const ndByRegion = new Map<string, number>();
  for (const s of stores) {
    if (hasData(s)) eff[s.status] += 1;
    else {
      eff.nodata += 1;
      const k = s.region ?? "";
      ndByRegion.set(k, (ndByRegion.get(k) ?? 0) + 1);
    }
  }

  return (
    <>
      <div className="head">
        <h1>Overview</h1>
        <div className="meta">
          <span>As of {fmtDate(asOf)}</span>
          {late && (
            <span className="stalepill">⚠ {label(late.source)} feed · {daysAgo(late.as_of)} late</span>
          )}
        </div>
      </div>

      {/* A stale PLAN is worse than a stale feed. The delivery sheet and the
          production sheet are printed FROM the plan, so a dead engine means the
          paper going out to the bakery is old, not just the figures on screen.

          Shown only when something is wrong -- a banner that is always there is
          furniture. Three states, because "ok" hid a real fault for six days:
          on 26 and 27 August the scheduled job failed twice while the numbers
          stayed correct, because the plan had been rebuilt by hand. The engine
          was fine and the cron was broken, and only one of those was visible. */}
      {engineHealth && (engineHealth.status !== "ok" || engineHealth.last_attempt_status === "failed") && (
        <div className={engineHealth.status === "ok" ? "feeddead enginedead warn" : "feeddead enginedead"}>
          <div className="fd-l">The plan</div>
          <div className="fd-h">
            {engineHealth.days_since_success > 3650 ? (
              <b>The plan has never been built.</b>
            ) : engineHealth.status === "stopped" ? (
              <b>The plan has not been rebuilt for {engineHealth.days_since_success} days.</b>
            ) : engineHealth.status === "late" ? (
              <b>The plan has not been rebuilt since {fmtWhen(engineHealth.last_successful_run)}.</b>
            ) : (
              <b>The overnight rebuild failed. Today&apos;s plan was built by hand.</b>
            )}
          </div>
          <div className="fd-b">
            {engineHealth.status === "ok" ? (
              <>Today&apos;s numbers are current, so nothing below is wrong. But the
              scheduled job is broken, and unless it is fixed it will not build
              tomorrow&apos;s plan either.</>
            ) : (
              <>Every recommendation below, and the delivery and production sheets,
              are printed from the plan of{" "}
              <b>{fmtWhen(engineHealth.last_successful_run)}</b>. Any sales that
              have arrived since are not in them.</>
            )}
            {engineHealth.last_attempt_status === "failed" && engineHealth.last_attempt && (
              <> Last scheduled attempt: <b>{fmtWhen(engineHealth.last_attempt)}</b>, failed.</>
            )}
          </div>
        </div>
      )}

      {/* A stopped feed is not a badge. Every figure below this line silently
          excludes those stores, and they look exactly like healthy zeroes. */}
      {darkInfo.length > 0 && (
        <div className="feeddead">
          <div className="fd-h">
            {darkInfo.map((d) => (
              <span key={d.source}>
                <b>{label(d.source)} has sent nothing for {d.days} days.</b>{" "}
              </span>
            ))}
          </div>
          <div className="fd-b">
            That is <b>{darkStores} stores</b>
            {darkShare > 0 && <> and about <b>{darkShare}%</b> of everything leaving the bakery</>}.
            Every number on this page excludes them — they are not selling badly,
            we cannot see them at all. Their waste, sell-through and lost sales are
            frozen at the last day we received.
          </div>
          <Link prefetch={false} href="/feeds" className="fd-a">Load the latest report →</Link>
        </div>
      )}

      <div className="hero">
        <div className="line">
          {eff.red ? <><b>{eff.red} stores</b> need you today.</> : <>Everything&apos;s on track today.</>}{" "}
          {/* "The rest are running themselves" is only true when the rest are
              actually green. With the Coles feed down, 170 of 265 stores have no
              sales reaching us at all — saying they're running themselves is the
              most reassuring possible reading of the least information. */}
          <span className="dim">
            {eff.nodata > eff.green
              ? <>{eff.nodata} more aren&apos;t reporting sales, so we can&apos;t tell you either way.</>
              : <>The rest are running themselves.</>}
          </span>
        </div>
        <div className="hstats">
          <Stat dot="var(--red)" n={eff.red} l="Need attention" />
          <Stat dot="var(--amber)" n={eff.amber} l="To watch" />
          <Stat dot="var(--green)" n={eff.green} l="On track" />
          {eff.nodata > 0 && <Stat dot="var(--muted)" n={eff.nodata} l="Awaiting feed" />}
        </div>
      </div>

      <EnginePanel scenarios={engine} feedStores={net.feed_stores} />

      <TodayDashboard stores={stores} net={net} asOf={fmtDate(asOf)} revenue={revenue} thresholds={thresholds} states={states} revByStore={revByStore} capOverrides={capOverrides} peakDay={peakDay} />

      {recs.length > 0 && (
        <>
          <div className="section-h" style={{ marginBottom: 6 }}>
            <span className="tick" />Needs you today <span className="badge">{recs.length}</span>
            <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, color: "var(--faint)", marginLeft: 4 }}>· the biggest fixes, spelled out</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, margin: "12px 0 22px" }}>
            {recs.map((r) => <RecCard key={r.store.store_id} rec={r} />)}
          </div>
        </>
      )}

      <AskBar />

      <div id="allregions" className="section-h" style={{ marginTop: 30 }}>
        <span className="tick" />All delivery runs <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, color: "var(--faint)" }}>· worst first</span>
      </div>
      <div className="rgrid">
        {regions.map((r) => {
          const nd = ndByRegion.get(r.region) ?? 0;
          const green = Math.max(0, r.green - nd);
          const kind = r.red ? "red" : r.amber ? "amber" : green > 0 ? "green" : "nodata";
          return (
            <Link prefetch={false} key={r.region_id} href={`/region/${encodeURIComponent(r.region)}`} className="rtile">
              <div className="rn">{r.region} <StatusTag status={kind} /></div>
              <div className="cbar">
                {r.red ? <span style={{ flex: r.red, background: "var(--red)" }} /> : null}
                {r.amber ? <span style={{ flex: r.amber, background: "var(--amber)" }} /> : null}
                {green ? <span style={{ flex: green, background: "var(--green)" }} /> : null}
                {nd ? <span style={{ flex: nd, background: "var(--line2)" }} /> : null}
              </div>
              <div className="mini">
                <span>{r.red} need · {r.amber} watch · {green} on track{nd ? ` · ${nd} awaiting feed` : ""}</span>
                <span className="rw">waste {r.waste_pct == null ? "—" : `${r.waste_pct}%`}</span>
              </div>
            </Link>
          );
        })}
      </div>

      <div className="foot">
        Live data · {net.stores} stores across {regions.length} regions. Waste is inferred from the on-hand ledger
        (retailers report only what sold). Exception-first: {eff.green} stores on track are running themselves
        {eff.nodata ? `; ${eff.nodata} are awaiting their retailer feed (Coles / Harris Farm) and aren't scored yet` : ""}.
      </div>
    </>
  );
}

function Stat({ dot, n, l }: { dot: string; n: number; l: string }) {
  return (
    <div className="stat">
      <div className="n"><span className="sdot" style={{ background: dot }} />{n}</div>
      <div className="l">{l}</div>
    </div>
  );
}

function label(src: string) {
  return src === "harris_farm" ? "Harris Farm" : src === "coles" ? "Coles" : src === "woolworths" ? "Woolworths" : src;
}
function daysAgo(d: Date) {
  const ms = Date.now() - new Date(d).getTime();
  const days = Math.max(1, Math.round(ms / 86400000));
  return `${days} day${days === 1 ? "" : "s"}`;
}
