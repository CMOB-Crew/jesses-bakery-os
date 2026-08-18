import NewStoreSetup from "@/components/NewStoreSetup";
import { getRegionNames } from "@/lib/queries";

export const metadata = { title: "New store · Jesse's Bakery OS" };
// Fetch the real region list per request (and keep off the build-time prerender
// path). Falls back to a built-in list inside the component if the DB is unreachable.
export const dynamic = "force-dynamic";

export default async function NewStorePage() {
  const regions = await getRegionNames();
  return (
    <>
      <div className="head">
        <h1>New store setup</h1>
        <div className="meta">Enter once, set the ceiling, let it fill</div>
      </div>
      <NewStoreSetup regions={regions} />
    </>
  );
}
