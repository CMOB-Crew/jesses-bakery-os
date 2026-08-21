import Link from "next/link";
import { notFound } from "next/navigation";
import { getStoreById, getStoreDaily, getStoreRecos, getStoreWeek, getStoreOverrides, getStoreRanging, getStoreServiceLevel, getStoreLastVisit, getStorePhoto, getStoreAddress, getStoreShelfCap } from "@/lib/queries";
import StoreProfile, { type PeerStat } from "@/components/StoreProfile";
import type { StoreWeek } from "@/lib/queries";

// Render per request, like the other data pages — this is the "single source of
// truth" profile Simona acts on, so it should never serve a cached/stale read,
// and it stays off the flaky build-time prerender path.
export const dynamic = "force-dynamic";

function median(xs: number[]): number | null {
  const a = xs.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  const v = a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  return Math.round(v * 10) / 10;
}
const stOf = (s: StoreWeek) =>
  Number(s.total_sent) > 0 ? (Number(s.total_sold) / Number(s.total_sent)) * 100 : null;

// Real peer comparison: same size_category if it's set and there are enough
// peers, else same region, else the whole network — so it always resolves to
// a real group. All from v_store_week.
const channelOf = (s: StoreWeek) => (s.retailer === "invoice" ? "Invoice" : "Retail");
function computePeer(store: StoreWeek, all: StoreWeek[]): PeerStat {
  // Compare only against OPERATING peers — stores with delivered volume this
  // week. Stores with no loaded data (0 sent) would drag the medians to zero
  // and make the ranking meaningless. And only against the SAME channel: a
  // direct-invoice store invoices exactly what it sells (~100% sell-through,
  // 0 waste), so mixing it into a retail store's peer set would pin the median
  // at an unreachable target and flag the retail store unfairly.
  const chan = channelOf(store);
  const active = all.filter((s) => Number(s.total_sent) > 0 && channelOf(s) === chan);
  const chanLabel = chan.toLowerCase(); // "retail" | "invoice"
  let group = store.size_category ? active.filter((s) => s.size_category === store.size_category) : [];
  let basis = store.size_category ? `${store.size_category} ${chanLabel} stores` : "";
  if (group.length < 4) { group = active.filter((s) => s.region === store.region); basis = `${store.region ?? "network"} ${chanLabel} stores`; }
  if (group.length < 4) { group = active; basis = `${chanLabel} stores`; }
  const peers = group.filter((s) => s.store_id !== store.store_id);
  const thisWaste = Number(store.waste_pct);
  const peerWastes = peers.map((s) => Number(s.waste_pct)).filter(Number.isFinite);
  const betterPct =
    peerWastes.length && Number.isFinite(thisWaste)
      ? Math.round((peerWastes.filter((w) => w > thisWaste).length / peerWastes.length) * 100)
      : null;
  const medWaste = median(peerWastes);
  const medSellThrough = median(peers.map(stOf).filter((v): v is number => v != null));
  // Relative verdict (Simona's ask): score this store against its peer group on
  // BOTH sell-through (higher = better) and waste (lower = better), never an
  // absolute target. Beats peer median on both -> high performer; behind on both
  // -> underperformer; mixed -> opportunity. Null when there's nothing to judge.
  const thisSellThrough = stOf(store);
  const wasteOk = medWaste != null && Number.isFinite(thisWaste) ? thisWaste <= medWaste : null;
  const sellOk = medSellThrough != null && thisSellThrough != null ? thisSellThrough >= medSellThrough : null;
  let verdict: PeerStat["verdict"] = null;
  if (wasteOk != null && sellOk != null) verdict = wasteOk && sellOk ? "high" : !wasteOk && !sellOk ? "under" : "opportunity";
  else if (wasteOk != null) verdict = wasteOk ? "high" : "under";
  else if (sellOk != null) verdict = sellOk ? "high" : "under";
  return { basis, count: peers.length, medWaste, medSellThrough, betterPct, verdict };
}

export default async function StorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [store, daily, recos, all, overrides, ranging, serviceLevel, lastVisit, photo, address, shelf] = await Promise.all([
    getStoreById(id), getStoreDaily(id), getStoreRecos(id), getStoreWeek(), getStoreOverrides(id),
    getStoreRanging(id), getStoreServiceLevel(id), getStoreLastVisit(id), getStorePhoto(id), getStoreAddress(id), getStoreShelfCap(id),
  ]);
  if (!store) notFound();

  const peer = computePeer(store, all);
  // This request's date (force-dynamic, so it's fresh per load), passed down so
  // the client profile can flag an overdue visit without reading the clock during
  // render — that's impure and the React-compiler lint rejects it.
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <div className="crumbs">
        <Link href="/">Overview</Link>
        {store.region && <> › <Link href={`/region/${encodeURIComponent(store.region)}`}>{store.region}</Link></>}
        {" "}› {store.name}
      </div>
      <StoreProfile store={store} recos={recos} daily={daily} peer={peer} overrides={overrides} ranging={ranging} serviceLevel={serviceLevel} lastVisit={lastVisit} today={today} photo={photo} address={address} shelfCap={shelf.shelfCap} noCap={shelf.noCap} />
    </>
  );
}
