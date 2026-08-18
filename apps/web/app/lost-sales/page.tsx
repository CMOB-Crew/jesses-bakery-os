import { getStockouts } from "@/lib/queries";
import LostSales from "@/components/LostSales";

export const metadata = { title: "Lost sales · Jesse's Bakery OS" };
export const dynamic = "force-dynamic";

export default async function LostSalesPage() {
  const data = await getStockouts();
  return (
    <>
      <div className="head">
        <h1>Lost sales</h1>
        <div className="meta">Where we&apos;re selling out — and the fix</div>
      </div>
      <LostSales data={data} />
    </>
  );
}
