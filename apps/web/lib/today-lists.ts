/* ------------------------------------------------------------------ *
 * Why the Overview's two lists are empty.
 *
 * 9 September, go-live morning. The Overview drew a blank: "Best
 * performers" empty, "Biggest losses" showing ten stores at 0 units,
 * dashes across both. The page's own explanation was
 *
 *     "Lights up as the sales feed fills."
 *
 * and the sales feed was full. All three retailers were current to 8
 * September, loaded that morning, zero exceptions. That sentence sends
 * whoever reads it to chase a report that already landed -- the same
 * class of mistake as the map painting invoice customers grey, and as
 * the Overview calling 201 unmeasured stores "On track": a
 * true-sounding sentence pointed at the wrong person.
 *
 * WHAT IS ACTUALLY MISSING
 *
 * Both lists are measured against what went OUT:
 *
 *     sell-through = sold / sent            null when sent is 0
 *     waste_pct    = (sent - sold) / sent   null when sent is 0
 *
 * and v_store_week.sent is summed from the deliveries and delivery_items
 * tables over the seven days ending at jb_asof() (migration 050, the
 * `sent` CTE). It is not read from store_reco and it is not the plan.
 * The legacy import loaded one week of delivery records, 17-23 August,
 * and nothing has been recorded since; the drivers start recording on
 * go-live. So sent is 0, every ratio is null, and both lists empty out
 * at once.
 *
 * THE THREE REASONS, BECAUSE THEY GO TO THREE DIFFERENT PEOPLE
 *
 *     no scan feed         chase the retailer's report
 *     no sales this week   the feed is connected and quiet
 *     no delivery record   ours, and it fills in as drivers confirm
 *
 * This module never invents a number to fill a list. It says which of
 * the three is missing. Pure, so scripts/today-lists-check.ts can assert
 * every branch without a database -- the lists themselves stay in
 * TodayDashboard.
 * ------------------------------------------------------------------ */

export type ListRow = {
  /** 'invoice' for a direct customer. Anything else is a retail scan store. */
  retailer?: string | null;
  /** False for a store that reports no scan sales at all. */
  has_sales_feed?: boolean | null;
  /** Units delivered in the window. v_store_week.total_sent. */
  sent: number;
  /** Units sold in the window. v_store_week.total_sold. */
  sold: number;
  /** Units delivered that did not sell. v_store_week.total_wasted. */
  wasted: number;
};

export type EmptyReason = { line: string; sub: string | null };

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * Whether a store belongs in "Biggest losses" at all.
 *
 * The list used to be every store sorted by wasted units and cut at ten,
 * with no floor. With nothing delivered that is ten stores at "0 units"
 * and "—", ranked 1 to 10, under a heading with a siren on it. Nobody
 * asked for a top ten of nothing, and a ranked list of zeroes reads as a
 * finding rather than an absence -- the same shape as the empty driver
 * run that showed eight stops.
 *
 * A loss needs something to have gone out and something to have come
 * back. Both, or the store is not in the list.
 */
export function hasLossToShow(r: ListRow): boolean {
  return r.sent > 0 && r.wasted > 0;
}

/**
 * Why a list came out empty, for the population it was drawn from.
 *
 * `bandLabel` is the size filter in the user's words ("Small stores"),
 * or null for all sizes.
 */
export function listEmptyReason(rows: ListRow[], bandLabel: string | null): EmptyReason {
  const retail = rows.filter((r) => r.retailer !== "invoice");

  // Nothing to score, and nothing anyone should do about it. An invoice
  // customer orders exactly what they want, so they have no sell-through
  // and no waste by definition -- not a missing measurement.
  if (retail.length === 0) {
    return {
      line: `No ${bandLabel ?? "retail stores"} in this view.`,
      sub: "Invoice customers order exactly what they want, so they are never scored here.",
    };
  }

  const withFeed = retail.filter((r) => r.has_sales_feed !== false);

  // Chase the retailer.
  if (withFeed.length === 0) {
    return {
      line: `No sales report reaches us from ${plural(retail.length, "this store", "these stores")}.`,
      sub: "Chase the retailer's report. Sell-through and waste cannot be worked out without it.",
    };
  }

  const selling = withFeed.filter((r) => r.sold > 0);
  const delivered = withFeed.filter((r) => r.sent > 0);

  if (delivered.length === 0) {
    // The feed is connected but quiet. Rare, and it is still the
    // retailer's end, so it does not get the delivery sentence.
    if (selling.length === 0) {
      return {
        line: "Nothing has sold and nothing is recorded as delivered here this week.",
        sub: "Both sides are empty, so there is nothing to measure yet.",
      };
    }

    // The one that was being reported as a feed problem. Say whose job it
    // is, and say plainly that chasing the feed will not fix it.
    return {
      line: `Sales are arriving from ${selling.length} ${plural(selling.length, "store", "stores")}, but nothing is recorded as delivered to ${plural(selling.length, "it", "them")} this week.`,
      sub:
        "Sell-through and waste are measured against what went out, so there is nothing yet to " +
        "measure them against. These fill in as the drivers confirm their deliveries. The sales " +
        "feed is not what is missing.",
    };
  }

  // Deliveries and sales both exist for somebody in this view, so the
  // list is empty for an ordinary reason: this particular cut is thin.
  return {
    line: bandLabel ? `No ${bandLabel} can be measured yet.` : "Lights up as more stores report.",
    sub: null,
  };
}
