import { getStoreWeek, getStoreStates, getShelfCapOverrides } from "@/lib/queries";
import StoresList from "@/components/StoresList";

// Render per request, like the other data pages — this reads the whole
// v_store_week ledger and takes ?view= drill-down params, so it can't be a
// static prerender anyway. Keeps it off the flaky build-time path and
// consistent with Overview/Products/Deliveries/Production.
export const dynamic = "force-dynamic";

export default async function StoresPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const [{ view }, stores, states, capOverrides] = await Promise.all([searchParams, getStoreWeek(), getStoreStates(), getShelfCapOverrides()]);
  return (
    <>
      <div className="head">
        <h1>Stores</h1>
        <div className="meta">{stores.length} active · search, filter and sort</div>
      </div>
      <StoresList stores={stores} initialView={view} states={states} capOverrides={capOverrides} />
    </>
  );
}
