import { withUser } from "@/lib/db";
import { getProductionPlan, getWeekdayShape, getRunState, getTraySizes } from "@/lib/queries";
import ProductionBoard from "@/components/ProductionBoard";
import { stripPack } from "@/lib/bake";

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
          // DISTINCT BAKES, not lines.length and not distinct product names.
          //
          // getProductionPlan() returns one row per product PER STATE — 91 rows
          // — so lines.length disagreed with every other count on the page. That
          // was fixed by counting distinct names. Then the pack-size merge moved
          // the goalposts again: the board now folds every SKU that strips to
          // the same bake onto one row, so BAGEL - PLAIN (X 5), (X 3) and the
          // loose one are three names and ONE line. Distinct names read 76 while
          // the sheet pills read 63 + 7, the stat tile 63 and the footer 63.
          //
          // ProductionBoard carries a comment about never reading "a separately-
          // aggregated network figure, which is what would let the headline and
          // the list disagree". This header sits outside the board and has now
          // done precisely that twice, so it folds by the SAME rule the board
          // uses — the shared stripPack, and only for tray-counted products,
          // because those are the only ones the board merges.
          <div className="meta">
            This week&apos;s bake plan ·{" "}
            {new Set(lines.map((l) => (traySizes[l.name] ? stripPack(l.name) : l.name))).size} lines
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
