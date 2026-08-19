import { getWeekdayShape, getSeasonalEvents } from "@/lib/queries";
import SeasonalityCalendar from "@/components/SeasonalityCalendar";

export const metadata = { title: "Seasonality · Jesse's Bakery OS" };
export const dynamic = "force-dynamic"; // render per request; keep off the flaky build-time prerender path

export default async function SeasonalityPage() {
  const [live, liveEvents] = await Promise.all([getWeekdayShape(), getSeasonalEvents()]);
  return (
    <>
      <div className="head">
        <h1>Seasonality</h1>
        <div className="meta">The events calendar the plan reads from</div>
      </div>
      <SeasonalityCalendar live={live} liveEvents={liveEvents} />
    </>
  );
}
