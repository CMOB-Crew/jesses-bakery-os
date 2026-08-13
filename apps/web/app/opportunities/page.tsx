import OpportunityFinder from "@/components/OpportunityFinder";

export const metadata = { title: "Opportunities · Jesse's Bakery OS" };

export default function OpportunitiesPage() {
  return (
    <>
      <div className="head">
        <h1>Opportunities</h1>
        <div className="meta">Where the next dollar is</div>
      </div>
      <OpportunityFinder />
    </>
  );
}
