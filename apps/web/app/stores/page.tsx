import { getStoreWeek } from "@/lib/queries";
import StoresList from "@/components/StoresList";

export const revalidate = 120; // cache pages ~2 min so navigation is instant (prefetchable)

export default async function StoresPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const [{ view }, stores] = await Promise.all([searchParams, getStoreWeek()]);
  return (
    <>
      <div className="head">
        <h1>Stores</h1>
        <div className="meta">{stores.length} active · search, filter and sort</div>
      </div>
      <StoresList stores={stores} initialView={view} />
    </>
  );
}
