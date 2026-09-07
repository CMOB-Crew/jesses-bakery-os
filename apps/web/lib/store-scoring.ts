/* Whether a store can be scored at all, and why not when it can't.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A MODULE AND NOT A ONE-LINER
 * ---------------------------------------------------------------------------
 * The rule was copy-pasted into five files: the Overview, the Stores list, the
 * network map, the region pages and the store profile. Each copy carries a
 * comment saying it must stay identical to the others. It did not:
 *
 *   * StoreProfile was missing the feed clause entirely, so a Coles shop with a
 *     dead feed read "strong performer" next to 0% sell-through while the
 *     Stores list called the same shop "No data" on the previous screen.
 *   * The Overview read "154 On track" while the Stores list read "Green 1 ·
 *     No data 170" -- the same 265 stores, 153 of them healthy on one page and
 *     unmeasurable on the other.
 *
 * A rule that five files must agree on is one function, not five comments
 * asking each other to behave.
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED, 7 SEPTEMBER
 * ---------------------------------------------------------------------------
 * Every copy tested `has_sales_feed !== false && (sent > 0 || sold > 0)`.
 *
 * The `|| sold > 0` half is the hole. Waste is (sent - sold) / sent. With
 * nothing delivered there is no denominator, so waste_pct is NULL -- and
 * jb_status is a CASE over comparisons, where NULL is never true:
 *
 *     waste_pct > 30                        -> red
 *     waste_pct >= 20 or stockout_days >= 1 -> amber
 *     otherwise                             -> green      <-- NULL lands here
 *
 * So a store with sales and no delivery record scores GREEN. Measured on
 * production the same day: all 201 stores the Overview called "On track" had
 * waste unknown and nothing delivered. Zero of them were assessed. The page
 * read "Everything's on track today."
 *
 * It was invisible until migration 086 because the app's clock was anchored to
 * a table nothing writes. as_of sat at 22 August, inside the one week of
 * delivery data the legacy import loaded (17-23 Aug), so sent was real and the
 * statuses were real. 086 moved as_of to 1 September -- past the end of the
 * delivery data -- and every store fell through the hole at once.
 *
 * The bakery goes live 9-12 September and the drivers start recording
 * deliveries, so the data gap closes itself. This does not: any store that ever
 * misses a delivery record reads "On track" until someone notices by hand.
 *
 * ---------------------------------------------------------------------------
 * WHY "NO DELIVERY" IS ITS OWN ANSWER AND NOT "AWAITING FEED"
 * ---------------------------------------------------------------------------
 * Both mean "we cannot score this", but they send someone to different places.
 * "Awaiting feed" says chase the retailer. For these 201 stores the feed is
 * fine -- the sales are arriving -- and what is missing is our own delivery
 * record. Sending Simona to chase Coles for a file that already landed is the
 * same class of mistake as the map painting invoice customers grey: a true
 * statement pointed at the wrong person.
 */

export type Status = "red" | "amber" | "green";

/** What a store resolves to once we ask whether it can be scored at all. */
export type Scored = Status | "invoice" | "no-feed" | "no-delivery";

export type ScoreInput = {
  /** 'invoice' for a direct customer. Anything else is a retail scan store. */
  retailer?: string | null;
  /** False for a store that reports no scan sales at all. */
  has_sales_feed?: boolean | null;
  /** Units delivered in the measurement window. */
  sent?: unknown;
  /** Units sold in the measurement window. */
  sold?: unknown;
  /** jb_status's answer. Only trusted once the store is measurable. */
  status?: string | null;
};

const n = (v: unknown) => Number(v) || 0;

/**
 * The single rule. Order matters and each step is a different person's problem:
 *
 *   invoice      nobody's problem -- there is no feed and there never will be
 *   no-feed      chase the retailer
 *   no-delivery  chase our own delivery record
 *   red/amber/green  a real measurement
 */
export function scoreStore(s: ScoreInput): Scored {
  // Wins outright. An invoice customer tells Jesse what they want; nothing
  // about them is forecast, so they can never be green, amber or red. Before
  // this they sat in the same grey as a store whose feed had gone dark, which
  // reads as "chase this feed" when there is nothing to chase. Simona, 1 Sept:
  // "how come grey is invoices... the schools are in grey."
  if (s.retailer === "invoice") return "invoice";

  // No scan sales reach us, so waste is unknowable rather than zero.
  if (s.has_sales_feed === false) return "no-feed";

  // Nothing delivered in the window: waste has no denominator. See the header.
  // This is the clause the five copies were missing.
  if (n(s.sent) <= 0) return "no-delivery";

  const st = s.status;
  if (st === "red" || st === "amber" || st === "green") return st;

  // jb_status returned something we do not recognise. Not scored -- guessing
  // here is how a NULL became green in the first place.
  return "no-delivery";
}

/** True only for a store we have actually assessed. */
export function isMeasured(v: Scored): v is Status {
  return v === "red" || v === "amber" || v === "green";
}

/** True when the store cannot be scored AND somebody should do something. */
export function isChaseable(v: Scored): boolean {
  return v === "no-feed" || v === "no-delivery";
}

export const SCORE_LABEL: Record<Scored, string> = {
  red: "Needs attention",
  amber: "Watch",
  green: "On track",
  invoice: "Invoice customer",
  "no-feed": "Awaiting feed",
  "no-delivery": "No delivery recorded",
};

/** One line saying who should do what. Null where there is nothing to chase. */
export function scoreNote(v: Scored): string | null {
  switch (v) {
    case "no-feed":
      return "No sales are reaching us from this retailer, so waste and sell-through cannot be worked out. Chase the report.";
    case "no-delivery":
      return "Sales are arriving, but nothing is recorded as delivered here in this period, so there is nothing to measure them against. The delivery record is what is missing, not the feed.";
    default:
      return null;
  }
}

/**
 * The Overview's headline. Kept here rather than in the page so the rule and
 * the sentence it justifies cannot drift apart.
 *
 * "Everything's on track today" must never appear when nothing was measured.
 * That sentence over 201 unassessed stores is the whole reason this module
 * exists.
 */
export function overviewHeadline(c: {
  red: number; amber: number; green: number;
  noFeed: number; noDelivery: number;
}): { line: string; sub: string | null } {
  const measured = c.red + c.amber + c.green;
  const unmeasured = c.noFeed + c.noDelivery;

  // Nothing was assessed. Deliberately not reassuring, and checked first so no
  // later branch can reach a sentence about how things are going.
  if (measured === 0) {
    return {
      line: "Nothing on this page has been measured today.",
      sub: unmeasured > 0
        ? `${unmeasured} stores are waiting on either a sales report or a delivery record.`
        : null,
    };
  }

  const sub = unmeasured > measured
    ? `${unmeasured} more cannot be measured, so we cannot tell you either way.`
    : "The rest are running themselves.";

  if (c.red > 0) {
    return { line: `${c.red} ${c.red === 1 ? "store needs" : "stores need"} you today.`, sub };
  }

  // Amber is not "on track". The first version of this function branched only
  // on red, so five stores over Simona's watch threshold still produced
  // "Everything's on track today." Caught by the test, not by reading it.
  if (c.amber > 0) {
    return { line: `${c.amber} ${c.amber === 1 ? "store" : "stores"} to watch.`, sub };
  }

  if (unmeasured > measured) {
    return { line: `${measured} ${measured === 1 ? "store is" : "stores are"} on track.`, sub };
  }

  return { line: "Everything's on track today.", sub: "The rest are running themselves." };
}
