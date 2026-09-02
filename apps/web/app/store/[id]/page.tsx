import { withUser } from "@/lib/db";
import Link from "next/link";
import NotFoundPanel from "@/components/NotFoundPanel";
import { getStoreById, getStoreRecos, getStoreWeek, getStoreOverrides, getStoreRanging, getStoreServiceLevel, getStoreLastVisit, getStorePhoto, getStoreAddress, getStoreShelfCap, getStoreDayGrid, getStoreSellouts, getStoreSchedule, getRunPicklist, getStoreRevenueWeek, getStoreStandingOrder, getProductPicklist } from "@/lib/queries";
import StoreProfile, { type PeerStat } from "@/components/StoreProfile";
import StandingOrderPanel from "@/components/StandingOrderPanel";
import type { StoreWeek } from "@/lib/queries";

// Render per request, like the other data pages — this is the "single source of
// truth" profile Simona acts on, so it should never serve a cached/stale read,
// and it stays off the flaky build-time prerender path.
export const dynamic = "force-dynamic";
// Netlify's platform maximum for a synchronous function is 60 seconds. No page
// here declared one, so every page ran on a default nobody chose — and the
// function log shows cold renders at 8.6, 10.0, 10.4 and 10.7 seconds with
// nothing above that, which is the shape of a ceiling around ten.
//
// This does not make the page fast. It stops a slow render being a broken one.
export const maxDuration = 60;

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
  // A peer also has to be a store we can actually measure. An invoice customer
  // never reports a scan sale, so it reads 0% sell-through and null waste; with
  // 153 of those in the network the "vs 11 large retail stores" strip was
  // quoting a peer median of 0% waste and 0% sell-through and calling every
  // real store an underperformer against it. Same rule as migration 027.
  const chan = channelOf(store);
  const active = all.filter(
    (s) => Number(s.total_sent) > 0 && channelOf(s) === chan && s.has_sales_feed !== false,
  );
  const chanLabel = chan.toLowerCase(); // "retail" | "invoice"
  let group = store.size_category ? active.filter((s) => s.size_category === store.size_category) : [];
  let basis = store.size_category ? `${store.size_category} ${chanLabel} stores` : "";
  if (group.length < 4) { group = active.filter((s) => s.region === store.region); basis = `${store.region ?? "network"} ${chanLabel} stores`; }
  if (group.length < 4) { group = active; basis = `${chanLabel} stores`; }
  const peers = group.filter((s) => s.store_id !== store.store_id);
  // Number(null) is 0, and 0 beats every peer — so a store whose waste is
  // UNKNOWABLE (feed dark) used to score as a flawless performer. NaN is not
  // finite, so the Number.isFinite guard below now correctly leaves it out.
  const thisWaste = store.waste_pct == null ? NaN : Number(store.waste_pct);
  // Number(null) is 0, and 0 is finite — so a null waste used to enter the
  // median as a perfect score rather than being left out of it.
  const peerWastes = peers
    .map((s) => (s.waste_pct == null ? null : Number(s.waste_pct)))
    .filter((w): w is number => w != null && Number.isFinite(w));
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
  // All in one Promise.all. Every one of these is a round trip to the Singapore
  // pooler at ~130ms; awaited in sequence the three new ones would add ~400ms to
  // a page Tommy already called slow on the 26 Aug screen share.
  const [store, recos, all, overrides, ranging, serviceLevel, lastVisit, photo, address, shelf, dayGrid, sellouts, schedule, runs, revMap, standingLines, allProducts] = await withUser(() =>
    Promise.all([
    getStoreById(id), getStoreRecos(id), getStoreWeek(), getStoreOverrides(id),
    getStoreRanging(id), getStoreServiceLevel(id), getStoreLastVisit(id), getStorePhoto(id), getStoreAddress(id), getStoreShelfCap(id),
    getStoreDayGrid(id), getStoreSellouts(id), getStoreSchedule(id), getRunPicklist(),
    // The dollar layer. Added to the SAME Promise.all rather than awaited after
    // it: the pooler round trip is ~130ms and these run concurrently, so this
    // costs the page nothing. getStoreRevenueWeek never throws — it returns an
    // empty map — so a store with no priced sales degrades to the units-only
    // panel instead of breaking the page.
    getStoreRevenueWeek(), getStoreStandingOrder(id), getProductPicklist(),
  ])
  );
  // Rendered directly, not via notFound(): this page is force-dynamic and
  // that boundary comes out blank here.
  if (!store) {
    return (
      <NotFoundPanel
        heading="That store is not here"
        body="It may have been archived, or the link may be out of date."
        primaryHref="/stores"
        primaryLabel="All stores"
      />
    );
  }

  const peer = computePeer(store, all);
  const revenue = revMap.get(id) ?? null;
  // This request's date (force-dynamic, so it's fresh per load), passed down so
  // the client profile can flag an overdue visit without reading the clock during
  // render — that's impure and the React-compiler lint rejects it.
  // Sydney, not UTC. toISOString() is UTC, so between midnight and 10am AEST
  // this page believed it was yesterday — the entire bakery working morning —
  // and the visit-date picker would not accept a visit made an hour ago.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());

  return (
    <>
      <div className="crumbs">
        <Link prefetch={false} href="/">Overview</Link>
        {store.region && <> › <Link prefetch={false} href={`/region/${encodeURIComponent(store.region)}`}>{store.region}</Link></>}
        {" "}› {store.name}
      </div>
      <StoreProfile store={store} recos={recos} revenue={revenue} peer={peer} overrides={overrides} ranging={ranging} serviceLevel={serviceLevel} lastVisit={lastVisit} today={today} photo={photo} address={address} shelfCap={shelf.shelfCap} noCap={shelf.noCap} dayGrid={dayGrid} sellouts={sellouts} schedule={schedule} runs={runs} />
      {store.retailer === "invoice" && (
        <StandingOrderPanel
          storeId={id}
          storeName={store.name}
          lines={standingLines}
          products={allProducts}
          today={today}
        />
      )}
    </>
  );
}
