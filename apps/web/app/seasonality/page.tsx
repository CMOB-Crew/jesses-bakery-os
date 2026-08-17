import { getWeekdayShape } from "@/lib/queries";
import SeasonalityCalendar from "@/components/SeasonalityCalendar";

export const metadata = { title: "Seasonality · Jesse's Bakery OS" };
export const revalidate = 120;

export default async function SeasonalityPage() {
  const live = await getWeekdayShape();
  return (
    <>
      <div className="head">
        <h1>Seasonality</h1>
        <div className="meta">The events calendar the engine plans against</div>
      </div>
      <SeasonalityCalendar live={live} />
    </>
  );
}
