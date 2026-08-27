import { withUser } from "@/lib/db";
import NewStoreSetup from "@/components/NewStoreSetup";
import { getRegionNames, getRuns } from "@/lib/queries";

export const metadata = { title: "New store · Jesse's Bakery OS" };
// Fetch the real region list per request (and keep off the build-time prerender
// path). Falls back to a built-in list inside the component if the DB is unreachable.
export const dynamic = "force-dynamic";

export default async function NewStorePage() {
  const [regions, runs] = await withUser(() =>
    Promise.all([getRegionNames(), getRuns()])
  );
  return (
    <>
      <div className="head">
        <h1>New store setup</h1>
        <div className="meta">Enter once, set the ceiling, let it fill</div>
      </div>
      <NewStoreSetup regions={regions} runs={runs} />
    </>
  );
}
