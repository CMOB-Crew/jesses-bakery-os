import Link from "next/link";
import { getNetwork, getRegions, getRecommendations, getAsOf, getFeedStatus, getEngineProjection, getStoreWeek } from "@/lib/queries";
import StatusTag from "@/components/StatusTag";
import RecCard from "@/components/RecCard";
import AskBar from "@/components/AskBar";
import EnginePanel from "@/components/EnginePanel";
import TodayDashboard from "@/components/TodayDashboard";

export const revalidate = 120; // cache pages ~2 min so navigation is instant (prefetchable)

function fmtDate(d: Date) {
  return new Intl.DateTimeFormat("en-AU", { weekday: "short", day: "numeric", month: "short" }).format(new Date(d));
}

export default async function Overview() {
  const [net, regions, recs, asOf, feeds, engine, stores] = await Promise.all([
    getNetwork(), getRegions(), getRecommendations(3), getAsOf(), getFeedStatus(), getEngineProjection(), getStoreWeek(),
  ]);

  const stale = feeds.find((f) => f.status === "stale");

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
          {net.red ? <><b>{net.red} stores</b> need you today.</> : <>Everything&apos;s on track today.</>}{" "}
          <span className="dim">The rest are running themselves.</span>
        </div>
        <div className="hstats">
          <Stat dot="var(--red)" n={net.red} l="Need attention" />
          <Stat dot="var(--amber)" n={net.amber} l="To watch" />
          <Stat dot="var(--green)" n={net.green} l="On track" />
        </div>
      </div>

      <EnginePanel scenarios={engine} />

      <TodayDashboard stores={stores} net={net} asOf={fmtDate(asOf)} />

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
        {regions.map((r) => (
          <Link key={r.region_id} href={`/region/${encodeURIComponent(r.region)}`} className="rtile">
            <div className="rn">{r.region} <StatusTag status={r.red ? "red" : r.amber ? "amber" : "green"} /></div>
            <div className="cbar">
              {r.red ? <span style={{ flex: r.red, background: "var(--red)" }} /> : null}
              {r.amber ? <span style={{ flex: r.amber, background: "var(--amber)" }} /> : null}
              {r.green ? <span style={{ flex: r.green, background: "var(--green)" }} /> : null}
            </div>
            <div className="mini">
              <span>{r.red} need · {r.amber} watch · {r.green} on track</span>
              <span className="rw">waste {r.waste_pct == null ? "—" : `${r.waste_pct}%`}</span>
            </div>
          </Link>
        ))}
      </div>

      <div className="foot">
        Live data · {net.stores} stores across {regions.length} regions. Waste is inferred from the on-hand ledger
        (retailers report only what sold). Exception-first: {net.green} stores on track are running themselves.
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
