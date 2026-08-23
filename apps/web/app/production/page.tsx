import { getProductionPlan, getWeekdayShape, getRunState, getAppSettings } from "@/lib/queries";
import ProductionBoard from "@/components/ProductionBoard";

export const metadata = { title: "Production · Jesse's Bakery OS" };
export const dynamic = "force-dynamic"; // render per request; keep off the flaky build-time prerender path

export default async function ProductionPage() {
  const [lines, shape, saved, settings] = await Promise.all([getProductionPlan(), getWeekdayShape(), getRunState("production"), getAppSettings()]);

  // Units-per-tray for the tray-counted lines (bagels + challah). Null/absent
  // until Simona confirms them in Settings — the board shows units and waits.
  const ts = (settings.tray_sizes ?? {}) as { bagel?: number | null; challah?: number | null };
  const traySizes = { bagel: ts.bagel ?? null, challah: ts.challah ?? null };

  return (
    <>
      <div className="head">
        <h1>Production</h1>
        {lines.length ? (
          <div className="meta">This week&apos;s bake plan · {lines.length} lines</div>
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
