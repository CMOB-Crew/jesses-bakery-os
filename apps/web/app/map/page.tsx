import { withUser } from "@/lib/db";
import { getMapStores, getRunBoard, getRunRoster } from "@/lib/queries";
import NetworkMap from "@/components/NetworkMap";
import RunBoard from "@/components/RunBoard";

export const metadata = { title: "Delivery Runs · Jesse's Bakery OS" };
// Render per request, consistent with the other data pages and off the flaky
// build-time prerender path (it reads the whole store-week view).
export const dynamic = "force-dynamic";

export default async function MapPage() {
  // In parallel, not in sequence. Each of these is a round trip to the
  // Singapore pooler at ~130ms; awaited one after another they would add most
  // of half a second to a page Tommy already called slow on the 26 Aug screen
  // share, and this page has a 10-second Netlify budget most of which a cold
  // start has already spent.
  const [runs, roster, stores] = await withUser(() =>
    Promise.all([
    getRunBoard(),
    getRunRoster(),
    getMapStores(),
  ])
  );

  return (
    <>
      <div className="head">
        <h1>Delivery Runs</h1>
        <div className="meta">Every run, the stores on it, and the days it goes out</div>
      </div>

      {/* Simona, 26 Aug [31:42]: "this whole concept of tracking which region
          has errors isn't functional, because all it's telling us is data about
          it and then we've got to open up the store to get to it."

          So the page now leads with the thing she can change, and the status
          diagram — which reports and cannot act — sits below it. That is a
          change of purpose rather than a rename: this screen stopped being a
          status board and became a management screen. Tommy asked at [33:00] to
          keep experimenting with the map, so it stays rather than being cut. */}
      <RunBoard runs={runs} members={roster.members} visitors={roster.visitors} />

      <div className="head" style={{ marginTop: 30 }}>
        <h2 className="h2sub">The network at a glance</h2>
        <div className="meta">Every store as a dot, grouped by its run</div>
      </div>
      <NetworkMap stores={stores} />

      <style>{`.h2sub{font-family:var(--serif);font-size:18px;font-weight:600;letter-spacing:-.2px;margin:0}`}</style>
    </>
  );
}
