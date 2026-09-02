import { withUser } from "@/lib/db";
import DriverApp from "@/components/DriverApp";
import { getPackingRuns, getStoreAddresses } from "@/lib/queries";

export const metadata = { title: "Driver · Jesse's Bakery OS" };
// Was statically rendered, which is why it could only ever show sample stops.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function DriverPage() {
  // Sydney, not UTC. Between midnight and 10am AEST a UTC date is yesterday --
  // the entire bakery working morning -- and the driver would be shown the
  // wrong day's run.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
  const [runs, addresses] = await withUser(() =>
    Promise.all([getPackingRuns(today), getStoreAddresses()]),
  );
  const pretty = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney", weekday: "long", day: "numeric", month: "long",
  }).format(new Date());
  return (
    <>
      <div className="head"><h1>Driver app</h1><div className="meta">Today&apos;s runs, stop by stop</div></div>
      <DriverApp runs={runs} addresses={addresses} day={pretty} />
    </>
  );
}
