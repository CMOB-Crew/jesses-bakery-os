import { getDeliveryPlan } from "@/lib/queries";
import DeliveriesBoard from "@/components/DeliveriesBoard";

export const metadata = { title: "Deliveries · Jesse's Bakery OS" };
export const revalidate = 120; // cache ~2 min

export default async function DeliveriesPage() {
  const lines = await getDeliveryPlan();

  return (
    <>
      <div className="head">
        <h1>Deliveries</h1>
        {lines.length ? (
          <div className="meta">This week&apos;s delivery plan · {lines.length} stores on plan</div>
        ) : null}
      </div>

      {lines.length ? (
        <DeliveriesBoard lines={lines} />
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
