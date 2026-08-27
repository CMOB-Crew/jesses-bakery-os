import { withUser } from "@/lib/db";
import Link from "next/link";
import { getDeliveryPlan, getDeliveryDetail } from "@/lib/queries";
import DeliverySheet from "@/components/DeliverySheet";

export const metadata = { title: "Delivery sheet · Jesse's Bakery OS" };
export const dynamic = "force-dynamic";

export default async function DeliverySheetPage() {
  const [plan, detail] = await withUser(() =>
    Promise.all([getDeliveryPlan(), getDeliveryDetail()])
  );

  return (
    <>
      <div className="head">
        <h1>Delivery sheet</h1>
        <div className="meta">
          <Link prefetch={false} href="/deliveries" style={{ color: "var(--crust-deep)", fontWeight: 600 }}>← Calm view</Link>
          <span style={{ marginLeft: 12 }}>store × product grid · edits save as store adjustments and flow to the plan</span>
        </div>
      </div>
      <DeliverySheet plan={plan} detail={detail} />
    </>
  );
}
