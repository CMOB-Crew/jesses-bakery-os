import { withUser } from "@/lib/db";
import { getWeekdayShape, getSeasonalEvents } from "@/lib/queries";
import SeasonalityCalendar from "@/components/SeasonalityCalendar";

export const metadata = { title: "Seasonality · Jesse's Bakery OS" };
export const dynamic = "force-dynamic";
// Netlify's platform maximum for a synchronous function is 60 seconds. No page
// here declared one, so every page ran on a default nobody chose — and the
// function log shows cold renders at 8.6, 10.0, 10.4 and 10.7 seconds with
// nothing above that, which is the shape of a ceiling around ten.
//
// This does not make the page fast. It stops a slow render being a broken one.
export const maxDuration = 60; // render per request; keep off the flaky build-time prerender path

export default async function SeasonalityPage() {
  const [live, liveEvents] = await withUser(() =>
    Promise.all([getWeekdayShape(), getSeasonalEvents()])
  );
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
