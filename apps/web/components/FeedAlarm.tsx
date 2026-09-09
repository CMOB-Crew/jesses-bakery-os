import Link from "next/link";
import { getFeedHealth } from "@/lib/queries";
import { alarmCopy } from "@/lib/feed-alarm";

/* ------------------------------------------------------------------ *
 * The bar that says a feed has gone quiet.
 *
 * WHY IT EXISTS
 *
 * Coles died on 3 August and stayed dead for three weeks under a green
 * light, because the legacy pipeline's error handler failed too --
 * ETL_Job_Log reads Status = 'Success' on all 259,303 rows it has ever
 * written. Fred's one ask on 26 August was that ours must not be able to
 * do the same: "Alert when a feed stops. engine_runs.sales_as_of is the
 * right tell for us. Half a day, and it's the difference between our
 * system and theirs."
 *
 * We were most of the way there and did not finish it. v_feed_health has
 * existed since migration 039 and is genuinely correct -- but it renders
 * on ONE page, /feeds, which is the page nobody opens when everything
 * looks fine. So the tell existed and nothing told anyone.
 *
 * It happened again in the week of go-live: on the nights of 5, 6 and 7
 * September the engine ran, reported ok, and re-planned the whole network
 * from sales it could only see up to 1 September. Nobody knew until
 * someone went looking on the 9th.
 *
 * WHAT IT DOES
 *
 * Renders above every page, on every route, when any retailer is 'late'
 * (3-5 days behind) or 'stopped' (more than 5). Says which retailer, how
 * far behind, and what it means for the numbers on the screen behind it.
 * Silent at 'ok', which is 2 days or less -- the feeds are a day behind
 * by nature and a bar that is always on is a bar nobody reads.
 *
 * Not dismissible. A feed that has stopped is not a notification, it is
 * the state of the business: every waste, sell-through and lost-sales
 * figure for that retailer's stores is stale while it is up.
 *
 * IT FAILS QUIET, NOT LOUD. getFeedHealth already swallows its own
 * errors and returns []. If the view is missing or the query fails this
 * renders nothing rather than putting a red bar across a working system.
 * ------------------------------------------------------------------ */

export default async function FeedAlarm() {
  const health = await getFeedHealth().catch(() => []);
  const copy = alarmCopy(health);
  if (!copy) return null;

  return (
    <div className={`feedalarm ${copy.level}`} role="status">
      <span className="fa-dot" aria-hidden="true" />
      <span className="fa-t">{copy.title}</span>
      <span className="fa-d">{copy.detail}</span>
      <span className="fa-w">{copy.warning}</span>
      <Link prefetch={false} href="/feeds" className="fa-a">
        Load it →
      </Link>
    </div>
  );
}
