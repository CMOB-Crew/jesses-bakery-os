import Link from "next/link";
import { notFound } from "next/navigation";
import { getStoreById, getStoreDaily, getStoreRecos } from "@/lib/queries";
import StoreProfile from "@/components/StoreProfile";

export const revalidate = 120; // cache pages ~2 min so navigation is instant (prefetchable)

export default async function StorePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [store, daily, recos] = await Promise.all([
    getStoreById(id), getStoreDaily(id), getStoreRecos(id),
  ]);
  if (!store) notFound();

  return (
    <>
      <div className="crumbs">
        <Link href="/">Overview</Link>
        {store.region && <> › <Link href={`/region/${encodeURIComponent(store.region)}`}>{store.region}</Link></>}
        {" "}› {store.name}
      </div>
      <StoreProfile store={store} recos={recos} daily={daily} />
    </>
  );
}
