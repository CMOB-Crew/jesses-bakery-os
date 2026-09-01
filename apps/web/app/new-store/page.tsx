import { withUser } from "@/lib/db";
import NewStoreSetup from "@/components/NewStoreSetup";
import { getRegionNames, getRuns } from "@/lib/queries";

export const metadata = { title: "New store · Jesse's Bakery OS" };
// Fetch the real region list per request (and keep off the build-time prerender
// path). Falls back to a built-in list inside the component if the DB is unreachable.
export const dynamic = "force-dynamic";
// Netlify's platform maximum for a synchronous function is 60 seconds. No page
// here declared one, so every page ran on a default nobody chose — and the
// function log shows cold renders at 8.6, 10.0, 10.4 and 10.7 seconds with
// nothing above that, which is the shape of a ceiling around ten.
//
// This does not make the page fast. It stops a slow render being a broken one.
export const maxDuration = 60;

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
