import Link from "next/link";
import { notFound } from "next/navigation";
import { getStoreById, getStoreDaily, getStoreRecos, getStoreWeek } from "@/lib/queries";
import StoreProfile, { type PeerStat } from "@/components/StoreProfile";
import type { StoreWeek } from "@/lib/queries";

export const revalidate = 120; // cache pages ~2 min so navigation is instant (prefetchable)

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
function computePeer(store: StoreWeek, all: StoreWeek[]): PeerStat {
  // Compare only against OPERATING peers — stores with delivered volume this
  // week. Stores with no loaded data (0 sent) would drag the medians to zero
  // and make the ranking meaningless.
  const active = all.filter((s) => Number(s.total_sent) > 0);
  let group = store.size_category ? active.filter((s) => s.size_category === store.size_category) : [];
  let basis = store.size_category ? `${store.size_category} stores` : "";
  if (group.length < 4) { group = active.filter((s) => s.region === store.region); basis = `${store.region ?? "network"} stores`; }
  if (group.length < 4) { group = active; basis = "active stores"; }
  const peers = group.filter((s) => s.store_id !== store.store_id);
  const thisWaste = Number(store.waste_pct);
  const peerWastes = peers.map((s) => Number(s.waste_pct)).filter(Number.isFinite);
  const betterPct =
    peerWastes.length && Number.isFinite(thisWaste)
      ? Math.round((peerWastes.filter((w) => w > thisWaste).length / peerWastes.length) * 100)
      : null;
  return {
    basis,
    count: peers.length,
    medWaste: median(peerWastes),
    medSellThrough: median(peers.map(stOf).filter((v): v is number => v != null)),
    betterPct,
  };
}

export default async function StorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [store, daily, recos, all] = await Promise.all([
    getStoreById(id), getStoreDaily(id), getStoreRecos(id), getStoreWeek(),
  ]);
  if (!store) notFound();

  const peer = computePeer(store, all);

  return (
    <>
      <div className="crumbs">
        <Link href="/">Overview</Link>
        {store.region && <> › <Link href={`/region/${encodeURIComponent(store.region)}`}>{store.region}</Link></>}
        {" "}› {store.name}
      </div>
      <StoreProfile store={store} recos={recos} daily={daily} peer={peer} />
    </>
  );
}
