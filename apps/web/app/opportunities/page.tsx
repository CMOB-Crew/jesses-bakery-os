import { getOpportunities } from "@/lib/queries";
import OpportunityFinder from "@/components/OpportunityFinder";

export const metadata = { title: "Opportunities · Jesse's Bakery OS" };
export const revalidate = 120;

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
