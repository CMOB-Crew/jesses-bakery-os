/* ------------------------------------------------------------------ *
 * What the feed alarm says, as a pure function of the feed-health rows.
 *
 * Kept out of the component on purpose. components/FeedAlarm.tsx reaches
 * lib/queries, which is `server-only`, so anything importing the component
 * drags a database module in with it and cannot be run from a script. The
 * decision -- bar or no bar, and in what words -- is the part worth
 * asserting, and it needs neither a database nor a renderer.
 *
 * scripts/feed-alarm-check.ts covers this, including the silent case,
 * which is the one most likely to be got wrong and least likely to be
 * noticed: production is healthy, so the correct behaviour today is to
 * show nothing at all.
 * ------------------------------------------------------------------ */

const LABEL: Record<string, string> = {
  coles: "Coles",
  woolworths: "Woolworths",
  harris_farm: "Harris Farm",
};

/** What the bar says, as a pure function of the feed health rows, so it can
 *  be asserted without a database and without rendering. The component below
 *  is then only the markup. Returns null when the bar should not appear at
 *  all -- which is the case that matters most and the easiest to get wrong. */
export type AlarmCopy = { level: "late" | "stopped"; title: string; detail: string; warning: string };

export function alarmCopy(
  health: { retailer: string; days_behind: number; status: string }[],
): AlarmCopy | null {
  const bad = health.filter((f) => f.status === "late" || f.status === "stopped");
  if (!bad.length) return null;

  const stopped = bad.filter((f) => f.status === "stopped");
  return {
    level: stopped.length ? "stopped" : "late",
    title: stopped.length
      ? stopped.length === 1 && bad.length === 1
        ? "A sales feed has stopped"
        : "Sales feeds have stopped"
      : bad.length === 1
        ? "A sales feed is falling behind"
        : "Sales feeds are falling behind",
    detail: bad
      .map((f) => `${LABEL[f.retailer] ?? f.retailer} ${f.days_behind} days behind`)
      .join(" · "),
    warning: stopped.length
      ? "Every waste, sell-through and lost-sales figure for those stores is stale until it is loaded."
      : "The plan is being rebuilt each night from sales this old.",
  };
}
