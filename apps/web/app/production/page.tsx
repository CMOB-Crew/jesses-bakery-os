import { getProductionPlan, getWeekdayShape } from "@/lib/queries";
import ProductionBoard from "@/components/ProductionBoard";

export const metadata = { title: "Production · Jesse's Bakery OS" };
export const revalidate = 120; // cache ~2 min

export default async function ProductionPage() {
  const [lines, shape] = await Promise.all([getProductionPlan(), getWeekdayShape()]);

  return (
    <>
      <div className="head">
        <h1>Production</h1>
        {lines.length ? (
          <div className="meta">This week&apos;s bake plan · engine-sized · {lines.length} lines</div>
        ) : null}
      </div>

      {lines.length ? (
        <ProductionBoard lines={lines} shape={shape} />
      ) : (
        // Empty until the plan is loaded — keep it honest, don't show a blank grid.
        <div className="panel">
          <div style={{ fontFamily: "var(--serif)", fontSize: 18, marginBottom: 8 }}>Bake plan is warming up</div>
          <div style={{ color: "var(--ink2)", maxWidth: 560, lineHeight: 1.6 }}>
            The bake plan totals the engine&apos;s per-store orders into a factory sheet — how much of each product to make.
            It lights up here as the plan is written on the mature Woolworths feed.
          </div>
        </div>
      )}
    </>
  );
}
