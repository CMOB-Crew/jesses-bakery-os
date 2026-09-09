import { withUser } from "@/lib/db";
import DriverApp from "@/components/DriverApp";
import { getPackingRuns, getStoreAddresses, getDriverState, getPackingFinalised, getDriverDayCounts } from "@/lib/queries";
import { getSessionClaims } from "@/lib/supabase/server";
import type { DriverDayCounts } from "@/lib/driver-day";

export const metadata = { title: "Driver · Jesse's Bakery OS" };
// Was statically rendered, which is why it could only ever show sample stops.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export default async function DriverPage() {
  // Sydney, not UTC. Between midnight and 10am AEST a UTC date is yesterday --
  // the entire bakery working morning -- and the driver would be shown the
  // wrong day's run.
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(new Date());
  // finalised rides along in the SAME round trip. This page already sits
  // behind Netlify's 60s ceiling with a Pacific crossing on every query, so a
  // fourth serial read would be the wrong way to answer one question.
  const [runs, addresses, state, finalised] = await withUser(() =>
    Promise.all([getPackingRuns(today), getStoreAddresses(), getDriverState(today), getPackingFinalised(today)]),
  );
  // Whoever is actually signed in. The screen used to say "Ankit / Van 3" to
  // everyone -- showing a real driver a different driver's name on their own
  // shift screen is worse than showing no name at all.
  const claims = await getSessionClaims().catch(() => null);
  const driver = claims?.email ? String(claims.email).split("@")[0] : null;
  // ONLY when the run came back empty. A normal morning has stops and never
  // reaches this, so the usual path stays exactly one round trip -- and this
  // page already sits behind Netlify's 60s ceiling with a Pacific crossing on
  // every query (see the note in lib/db.ts).
  //
  // Same withUser context as the reads above, deliberately: the question is not
  // "does a plan exist" but "can THIS PHONE see one", and a privileged read
  // would answer the wrong one.
  let counts: DriverDayCounts | null = null;
  if (runs.length === 0) {
    counts = await withUser(() => getDriverDayCounts(today)).catch(() => null);
  }
  const pretty = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney", weekday: "long", day: "numeric", month: "long",
  }).format(new Date());
  return (
    <>
      <div className="head drvhead"><h1>Driver app</h1><div className="meta">Today&apos;s runs, stop by stop</div></div>
      <style>{".drvhead{display:block}@media(max-width:760px){.drvhead{display:none}}"}</style>
      <DriverApp runs={runs} addresses={addresses} day={pretty} dayIso={today} driver={driver} initialState={state} finalised={finalised} counts={counts} />
    </>
  );
}
