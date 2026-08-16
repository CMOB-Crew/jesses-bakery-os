import { getMapStores } from "@/lib/queries";
import NetworkMap from "@/components/NetworkMap";

export const metadata = { title: "Network map · Jesse's Bakery OS" };
export const revalidate = 120;

export default async function MapPage() {
  const stores = await getMapStores();
  return (
    <>
      <div className="head">
        <h1>Network map</h1>
        <div className="meta">The whole network at a glance</div>
      </div>
      <NetworkMap stores={stores} />
    </>
  );
}
