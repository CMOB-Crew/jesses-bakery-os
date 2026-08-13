import SeasonalityCalendar from "@/components/SeasonalityCalendar";

export const metadata = { title: "Seasonality · Jesse's Bakery OS" };

export default function SeasonalityPage() {
  return (
    <>
      <div className="head">
        <h1>Seasonality</h1>
        <div className="meta">The events calendar the engine plans against</div>
      </div>
      <SeasonalityCalendar />
    </>
  );
}
