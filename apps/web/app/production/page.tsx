import { withUser } from "@/lib/db";
import { getProductionPlan, getWeekdayShape, getRunState, getTraySizes } from "@/lib/queries";
import ProductionBoard from "@/components/ProductionBoard";

export const metadata = { title: "Production · Jesse's Bakery OS" };
export const dynamic = "force-dynamic"; // render per request; keep off the flaky build-time prerender path

export default async function ProductionPage() {
  const [lines, shape, saved, traySizes] = await withUser(() =>
    Promise.all([getProductionPlan(), getWeekdayShape(), getRunState("production"), getTraySizes()])
  );

  return (
    <>
      <div className="head">
        <h1>Production</h1>
        {lines.length ? (
          // DISTINCT PRODUCTS, not lines.length. getProductionPlan() returns one
          // row per product PER STATE — 91 rows for 76 products — so the raw
          // length disagreed with every other count on the page: the sheet pills
          // (Regular 69 + Sourdough 7), the stat tile (69) and the footer (69).
          //
          // ProductionBoard already folds the state rows down in allLines, and
          // carries a comment about never reading "a separately-aggregated
          // network figure, which is what would let the headline and the list
          // disagree". This header sat outside the board and did precisely that.
          <div className="meta">
            This week&apos;s bake plan · {new Set(lines.map((l) => l.name)).size} lines
          </div>
        ) : null}
      </div>

      {lines.length ? (
        <ProductionBoard lines={lines} shape={shape} saved={saved} traySizes={traySizes} />
      ) : (
        // Empty until the plan is loaded — keep it honest, don't show a blank grid.
        <div className="panel">
          <div style={{ fontFamily: "var(--serif)", fontSize: 18, marginBottom: 8 }}>Bake plan is warming up</div>
          <div style={{ color: "var(--ink2)", maxWidth: 560, lineHeight: 1.6 }}>
            The bake plan totals each store&apos;s orders into a factory sheet — how much of each product to make.
            It lights up here as the plan is written on the Woolworths feed.
          </div>
        </div>
      )}
    </>
  );
}
