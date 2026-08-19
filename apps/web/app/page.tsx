import Link from "next/link";
import { getNetwork, getRegions, getRecommendations, getAsOf, getFeedStatus, getEngineProjection, getStoreWeek, getStoreRevenueWeek } from "@/lib/queries";
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

function fmtDate(d: Date) {
  return new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short" }).format(new Date(d));
}

export default async function Overview() {
  const [net, regions, recs, asOf, feeds, engine, stores, revMap] = await Promise.all([
    getNetwork(), getRegions(), getRecommendations(3), getAsOf(), getFeedStatus(), getEngineProjection(), getStoreWeek(), getStoreRevenueWeek(),
  ]);

  const stale = feeds.find((f) => f.status === "stale");

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

  // Honest status counts: a store with nothing delivered AND nothing sold has no
  // loaded feed yet (Coles/Harris) — it is NOT "on track". Count it separately as
  // "awaiting feed" so the headline reflects real coverage, not ~110 blank stores
  // glowing green. Computed here from the store rows so the hero and the region
  // cards stay in lockstep.
  const hasData = (s: StoreWeek) => Number(s.total_sent) > 0 || Number(s.total_sold) > 0;
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
          {stale && (
            <span className="stalepill">⚠ {label(stale.source)} feed · {daysAgo(stale.as_of)} stale</span>
          )}
        </div>
      </div>

      <div className="hero">
        <div className="line">
          {eff.red ? <><b>{eff.red} stores</b> need you today.</> : <>Everything&apos;s on track today.</>}{" "}
          <span className="dim">The rest are running themselves.</span>
        </div>
        <div className="hstats">
          <Stat dot="var(--red)" n={eff.red} l="Need attention" />
          <Stat dot="var(--amber)" n={eff.amber} l="To watch" />
          <Stat dot="var(--green)" n={eff.green} l="On track" />
          {eff.nodata > 0 && <Stat dot="var(--muted)" n={eff.nodata} l="Awaiting feed" />}
        </div>
      </div>

      <EnginePanel scenarios={engine} />

      <TodayDashboard stores={stores} net={net} asOf={fmtDate(asOf)} revenue={revenue} />

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
        <span className="tick" />All regions <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, color: "var(--faint)" }}>· worst first</span>
      </div>
      <div className="rgrid">
        {regions.map((r) => {
          const nd = ndByRegion.get(r.region) ?? 0;
          const green = Math.max(0, r.green - nd);
          const kind = r.red ? "red" : r.amber ? "amber" : green > 0 ? "green" : "nodata";
          return (
            <Link key={r.region_id} href={`/region/${encodeURIComponent(r.region)}`} className="rtile">
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
