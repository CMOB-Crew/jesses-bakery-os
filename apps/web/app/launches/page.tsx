import { getLaunches, getProductLaunches } from "@/lib/queries";
import LaunchesView from "@/components/Launches";

export const metadata = { title: "Launches · Jesse's Bakery OS" };
// Render per request, not at build. The launch lists must always reflect the
// live store master (a rollout just added, a store just flipped live), and this
// keeps the page off the build-time prerender path, where a slow Supabase can
// otherwise bake an empty page.
export const dynamic = "force-dynamic";

export default async function LaunchesPage() {
  const [launches, productLaunches] = await Promise.all([getLaunches(), getProductLaunches()]);
  return (
    <>
      <div className="head">
        <h1>Launches</h1>
        <div className="meta">New store &amp; product launches, tracked from day one</div>
      </div>
      <LaunchesView launches={launches} productLaunches={productLaunches} />
    </>
  );
}
