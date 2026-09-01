import { withUser } from "@/lib/db";
import { getStoreWeek, getStoreStates, getShelfCapOverrides, getPeakDaySold } from "@/lib/queries";
import StoresList from "@/components/StoresList";

// Render per request, like the other data pages — this reads the whole
// v_store_week ledger and takes ?view= drill-down params, so it can't be a
// static prerender anyway. Keeps it off the flaky build-time path and
// consistent with Overview/Products/Deliveries/Production.
export const dynamic = "force-dynamic";
// Netlify's platform maximum for a synchronous function is 60 seconds. No page
// here declared one, so every page ran on a default nobody chose — and the
// function log shows cold renders at 8.6, 10.0, 10.4 and 10.7 seconds with
// nothing above that, which is the shape of a ceiling around ten.
//
// This does not make the page fast. It stops a slow render being a broken one.
export const maxDuration = 60;

export default async function StoresPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const [{ view }, stores, states, capOverrides, peakDay] = await withUser(() =>
    Promise.all([searchParams, getStoreWeek(), getStoreStates(), getShelfCapOverrides(), getPeakDaySold()])
  );
  return (
    <>
      <div className="head">
        <h1>Stores</h1>
        <div className="meta">{stores.length} active · search, filter and sort</div>
      </div>
      <StoresList stores={stores} initialView={view} states={states} capOverrides={capOverrides} peakDay={peakDay} />
    </>
  );
}
