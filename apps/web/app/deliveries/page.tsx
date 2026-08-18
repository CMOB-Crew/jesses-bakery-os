import Link from "next/link";
import { getDeliveryPlan, getDeliveryDetail, getWeekdayShape } from "@/lib/queries";
import DeliveriesBoard from "@/components/DeliveriesBoard";

export const metadata = { title: "Deliveries · Jesse's Bakery OS" };
// Heavy per-store × per-product plan; render per request and stay off the
// build-time prerender path (like the other data pages).
export const dynamic = "force-dynamic";

export default async function DeliveriesPage() {
  const [lines, detail, shape] = await Promise.all([getDeliveryPlan(), getDeliveryDetail(), getWeekdayShape()]);

  return (
    <>
      <div className="head">
        <h1>Deliveries</h1>
        {lines.length ? (
          <div className="meta">This week&apos;s delivery plan · {lines.length} stores on plan · <Link href="/delivery-sheet" style={{ color: "var(--crust-deep)", fontWeight: 600 }}>spreadsheet grid →</Link></div>
        ) : null}
      </div>

      {lines.length ? (
        <DeliveriesBoard lines={lines} detail={detail} shape={shape} />
      ) : (
        // Empty until the plan is loaded — keep it honest, don't show a blank grid.
        <div className="panel">
          <div style={{ fontFamily: "var(--serif)", fontSize: 18, marginBottom: 8 }}>Order sheet is warming up</div>
          <div style={{ color: "var(--ink2)", maxWidth: 560, lineHeight: 1.6 }}>
            The delivery order sheet is generated from the plan on the mature Woolworths feed.
            It lights up here store-by-store as the plan is written.
          </div>
        </div>
      )}
    </>
  );
}
