import { getStoreWeek } from "@/lib/queries";
import StoresBoard from "@/components/StoresBoard";

export const revalidate = 120; // cache pages ~2 min so navigation is instant (prefetchable)

export default async function StoresPage() {
  const stores = await getStoreWeek();
  return (
    <>
      <div className="head"><h1>Stores</h1><div className="meta">{stores.length} active · worst first</div></div>
      <StoresBoard stores={stores} />
    </>
  );
}
