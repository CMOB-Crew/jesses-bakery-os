import { getMapStores } from "@/lib/queries";
import NetworkMap from "@/components/NetworkMap";

export const metadata = { title: "Delivery Runs · Jesse's Bakery OS" };
// Render per request, consistent with the other data pages and off the flaky
// build-time prerender path (it reads the whole store-week view).
export const dynamic = "force-dynamic";

export default async function MapPage() {
  const stores = await getMapStores();
  return (
    <>
      <div className="head">
        <h1>Delivery Runs</h1>
        <div className="meta">Every run, and the stores on it</div>
      </div>
      <NetworkMap stores={stores} />
    </>
  );
}
