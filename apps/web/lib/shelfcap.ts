// The one definition of "this store's shelf cap is stale".
//
// Simona, 26 Aug: "the shelf cap on file 90 looks out of date. This store has
// sold 220 units this week... can this be like in a different colour so that I
// can spot it and see this, like alert? And will this alert also come somewhere
// else when I have my action items?"
//
// It used to live as one line inside StoreProfile. Now the same judgement has to
// be made in three places — the store profile banner, the Overview action list,
// and the Stores drill-down that the action list links to — and those three have
// to agree exactly, or she clicks "12 stores" and lands on a list of 9. Every
// other count on the Overview already pairs with a StoresList predicate for that
// reason (see VIEWS in StoresList.tsx); this is the same contract, written once.
//
// The test itself: a shelf cap is a physical limit — how many units the fixture
// holds at any moment. A store that SOLD 220 units in a week cannot have a
// 90-unit shelf that was never restocked, so a cap below a week's sales isn't a
// tight limit, it's bad data. We don't enforce it, we flag it.
//
// Two stores are deliberately never flagged:
//   - a "no fixed limit" store (a DC that picks to order) has no cap to be stale;
//   - a store with no sales this week gives us nothing to judge the cap against —
//     silence is not evidence the cap is wrong.

export type ShelfCapOverride = { cap: number | null; noCap: boolean };

/** The row shape both the profile and the lists have to hand. */
export type ShelfCapStore = {
  shelf_max: number | null;
  total_sold: number | string | null;
};

const num = (v: number | string | null | undefined) => Number(v) || 0;

/**
 * The cap actually in force: a hand-set per-store override wins over the
 * size-band default; a no-limit store has no ceiling at all.
 */
export function effectiveCap(
  s: ShelfCapStore,
  ov?: ShelfCapOverride,
): number | null {
  if (ov?.noCap) return null;
  const own = ov?.cap ?? null;
  if (own != null) return own;
  return s.shelf_max == null ? null : Number(s.shelf_max);
}

/** True when the cap on file is below what the store sold in the week. */
export function isCapStale(s: ShelfCapStore, ov?: ShelfCapOverride): boolean {
  const cap = effectiveCap(s, ov);
  const sold = num(s.total_sold);
  return cap != null && sold > 0 && cap < sold;
}
