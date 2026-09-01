import { withUser } from "@/lib/db";
import { getLaunches, getProductLaunches } from "@/lib/queries";
import LaunchesView from "@/components/Launches";

export const metadata = { title: "Launches · Jesse's Bakery OS" };
// Render per request, not at build. The launch lists must always reflect the
// live store master (a rollout just added, a store just flipped live), and this
// keeps the page off the build-time prerender path, where a slow Supabase can
// otherwise bake an empty page.
export const dynamic = "force-dynamic";
// Netlify's platform maximum for a synchronous function is 60 seconds. No page
// here declared one, so every page ran on a default nobody chose — and the
// function log shows cold renders at 8.6, 10.0, 10.4 and 10.7 seconds with
// nothing above that, which is the shape of a ceiling around ten.
//
// This does not make the page fast. It stops a slow render being a broken one.
export const maxDuration = 60;

export default async function LaunchesPage() {
  const [launches, productLaunches] = await withUser(() =>
    Promise.all([getLaunches(), getProductLaunches()])
  );
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
