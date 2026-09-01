import { getOpportunities } from "@/lib/queries";
import OpportunityFinder from "@/components/OpportunityFinder";

export const metadata = { title: "Opportunities · Jesse's Bakery OS" };
export const dynamic = "force-dynamic";
// Netlify's platform maximum for a synchronous function is 60 seconds. No page
// here declared one, so every page ran on a default nobody chose — and the
// function log shows cold renders at 8.6, 10.0, 10.4 and 10.7 seconds with
// nothing above that, which is the shape of a ceiling around ten.
//
// This does not make the page fast. It stops a slow render being a broken one.
export const maxDuration = 60;

export default async function OpportunitiesPage() {
  const data = await getOpportunities();
  return (
    <>
      <div className="head">
        <h1>Opportunities</h1>
        <div className="meta">Where the next dollar is</div>
      </div>
      <OpportunityFinder data={data} />
    </>
  );
}
