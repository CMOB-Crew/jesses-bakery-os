import LostSales from "@/components/LostSales";

export const metadata = { title: "Lost sales · Jesse's Bakery OS" };

export default function LostSalesPage() {
  return (
    <>
      <div className="head">
        <h1>Lost sales</h1>
        <div className="meta">Where we&apos;re selling out — and the fix</div>
      </div>
      <LostSales />
    </>
  );
}
