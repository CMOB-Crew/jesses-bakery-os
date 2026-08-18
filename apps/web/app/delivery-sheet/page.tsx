import Link from "next/link";
import { getDeliveryPlan, getDeliveryDetail } from "@/lib/queries";
import DeliverySheet from "@/components/DeliverySheet";

export const metadata = { title: "Delivery sheet · Jesse's Bakery OS" };
export const dynamic = "force-dynamic";

export default async function DeliverySheetPage() {
  const [plan, detail] = await Promise.all([getDeliveryPlan(), getDeliveryDetail()]);

  return (
    <>
      <div className="head">
        <h1>Delivery sheet</h1>
        <div className="meta">
          <Link href="/deliveries" style={{ color: "var(--crust-deep)", fontWeight: 600 }}>← Calm view</Link>
          <span style={{ marginLeft: 12 }}>store × product grid · a working draft until write-back to packers &amp; production is wired</span>
        </div>
      </div>
      <DeliverySheet plan={plan} detail={detail} />
    </>
  );
}
