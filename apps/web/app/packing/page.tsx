import { withUser } from "@/lib/db";
import { getPackingDays, getPackingRuns, getWeekdayShape, getPackingState } from "@/lib/queries";
import { getDisplayUser } from "@/lib/supabase/server";
import PackingApp from "@/components/PackingApp";

export const metadata = { title: "Packing · Jesse's Bakery OS" };
// Was the one page in the app that was not force-dynamic, because it had no
// data behind it. It does now.
export const dynamic = "force-dynamic";

const SYD = "Australia/Sydney";

// The Sydney date, not the server's. The same trap that filed 7am approvals
// under yesterday until 27 Aug: UTC does not roll over until 10am Sydney, and
// a bakery packs in the morning.
function sydneyToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SYD, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

// Label a plain YYYY-MM-DD without letting a timezone shift it a day either
// way. Built at UTC noon-equivalent from its own parts, formatted in UTC.
function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "long", day: "numeric", month: "long", timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export default async function PackingPage({
  searchParams,
}: {
  searchParams: Promise<{ day?: string }>;
}) {
  // The measured weekday curve rides along in the same round trip. It splits
  // a standing order into this day exactly as the Deliveries sheet splits it.
  // Null is fine -- dayshare falls back to the seed curve.
  const [sp, days, user, shape] = await Promise.all([
    searchParams,
    withUser(() => getPackingDays()),
    getDisplayUser().catch(() => null),
    withUser(() => getWeekdayShape()),
  ]);

  const today = sydneyToday();
  const asked = sp.day ?? "";
  // Only ever a day the engine has actually planned. A URL asking for anything
  // else falls back to today, then to the first planned day.
  const day = days.includes(asked) ? asked : days.includes(today) ? today : (days[0] ?? today);

  const [runs, packState] = await withUser(() =>
    Promise.all([getPackingRuns(day, shape), getPackingState(day)]),
  );
  const who = user?.email ? user.email.split("@")[0] : "Packing";

  return (
    <>
      <div className="head">
        <h1>Packing</h1>
        <div className="meta">The run sheet the bakery packs from · live plan</div>
      </div>
      {/* key={day} forces a remount on a day change. Without it React keeps the
          previous day's tick state and the previous run index, which can point
          past the end of a shorter day's run list. */}
      <PackingApp
        key={day}
        runs={runs}
        initial={packState}
        day={day}
        dayLabel={dayLabel(day)}
        days={days.map((d) => ({ value: d, label: dayLabel(d) }))}
        who={who}
      />
    </>
  );
}
