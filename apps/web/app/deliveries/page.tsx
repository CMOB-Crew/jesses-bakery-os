import { withUser } from "@/lib/db";
import Link from "next/link";
import { getDeliveryPlan, getDeliveryDetail, getWeekdayShape, getRunState, getRuns } from "@/lib/queries";
import DeliveriesBoard from "@/components/DeliveriesBoard";

export const metadata = { title: "Deliveries · Jesse's Bakery OS" };
// Heavy per-store × per-product plan; render per request and stay off the
// build-time prerender path (like the other data pages).
export const dynamic = "force-dynamic";
// Netlify's platform maximum for a synchronous function is 60 seconds. No page
// here declared one, so every page ran on a default nobody chose — and the
// function log shows cold renders at 8.6, 10.0, 10.4 and 10.7 seconds with
// nothing above that, which is the shape of a ceiling around ten.
//
// This does not make the page fast. It stops a slow render being a broken one.
export const maxDuration = 60;

export default async function DeliveriesPage() {
  const [lines, detail, shape, saved, runs] = await withUser(() =>
    Promise.all([getDeliveryPlan(), getDeliveryDetail(), getWeekdayShape(), getRunState("deliveries"), getRuns()])
  );

  return (
    <>
      <div className="head">
        <h1>Deliveries</h1>
        {lines.length ? (
          <div className="meta">This week&apos;s delivery plan · {lines.length} stores on plan · <Link prefetch={false} href="/delivery-sheet" style={{ color: "var(--crust-deep)", fontWeight: 600 }}>spreadsheet grid →</Link></div>
        ) : null}
      </div>

      {lines.length ? (
        <DeliveriesBoard lines={lines} detail={detail} shape={shape} saved={saved} runs={runs} />
      ) : (
        // Empty until the plan is loaded — keep it honest, don't show a blank grid.
        <div className="panel">
          <div style={{ fontFamily: "var(--serif)", fontSize: 18, marginBottom: 8 }}>Order sheet is warming up</div>
          <div style={{ color: "var(--ink2)", maxWidth: 560, lineHeight: 1.6 }}>
            The delivery order sheet is generated from the plan on the Woolworths feed.
            It lights up here store-by-store as the plan is written.
          </div>
        </div>
      )}
    </>
  );
}
