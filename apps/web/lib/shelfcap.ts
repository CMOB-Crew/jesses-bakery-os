// The one definition of "this store's shelf cap is wrong".
//
// Simona, 26 Aug: "the shelf cap on file 90 looks out of date. This store has
// sold 220 units this week... can this be like in a different colour so that I
// can spot it and see this, like alert? And will this alert also come somewhere
// else when I have my action items?"
//
// -------------------------------------------------------------------------
// WHY THIS IS NOT A WEEKLY TEST
//
// The first version of this file did exactly what that sentence says: flag a
// store whose cap is below what it SOLD IN A WEEK. It fired on 84 of the 95
// stores we can measure, which is how we caught it — an alert that fires on 88%
// of the network is not an alert, it is a background condition.
//
// A shelf cap is a SNAPSHOT: how many units the fixture holds at one moment.
// Weekly sales are a FLOW: the sum of six deliveries sold through and restocked
// the next morning. Woolworths Metro Coogee holds 90 and sells 239 a week —
// about 34 a day into a 90-unit bay, refilled six mornings a week. Nothing is
// wrong with that cap. Comparing the two is the restaurant-seats mistake: a
// 90-seat room is not too small because 240 people ate there this week.
//
// (That is the same shape as the waste, on-hand and stockout bugs before it —
// a number that is arithmetically fine and semantically meaningless. Hence this
// comment, at length, so the next person doesn't reach for total_sold again.)
//
// The test that survives is per-day. If a store sold 161 units on its busiest
// single day, the shelf held at least 161 units at some point that day, so a cap
// of 140 cannot be the real fixture size. On the live data that is one store,
// Woolworths Double Bay — which is what an alert is supposed to look like.
//
// It is deliberately conservative. Staff do refill a bread bay from a trolley
// during the day, so a peak day above the cap is strong evidence and not proof.
// We flag it for a human to check; we never act on it.
// -------------------------------------------------------------------------
//
// It lives in its own file because the same judgement now has to be made in
// three places — the store profile banner, the Overview action list, and the
// Stores drill-down the action list links to — and those three have to agree
// exactly, or she clicks "3 stores" and lands on a list of 9.

export type ShelfCapOverride = { cap: number | null; noCap: boolean };

/** The only field either list needs off the store row. */
export type ShelfCapStore = { shelf_max: number | null };

/**
 * The cap actually in force: a hand-set per-store override wins over the
 * size-band default; a no-limit store (a DC that picks to order) has no ceiling.
 *
 * Zero is not a cap. 30 stores carry shelf_max = 0, which means "nobody has
 * filled this in", not "this store has no shelf" — treating it as a real
 * ceiling put a red "exceeds the shelf cap of 0" banner on every one of them.
 * A zero reads as unset, which is what it is.
 */
export function effectiveCap(
  s: ShelfCapStore,
  ov?: ShelfCapOverride,
): number | null {
  if (ov?.noCap) return null;
  const own = ov?.cap ?? null;
  const raw = own != null ? Number(own) : s.shelf_max == null ? null : Number(s.shelf_max);
  if (raw == null || !Number.isFinite(raw) || raw <= 0) return null;
  return raw;
}

/**
 * True when the store demonstrably held more stock than its cap allows.
 *
 * @param peakDaySold units sold on the store's busiest single day of the week.
 *                    Null/absent means we can't judge, and we don't flag —
 *                    silence is not evidence the cap is wrong.
 */
export function isCapStale(
  s: ShelfCapStore,
  ov?: ShelfCapOverride,
  peakDaySold?: number | null,
): boolean {
  const cap = effectiveCap(s, ov);
  const peak = Number(peakDaySold) || 0;
  return cap != null && peak > 0 && cap < peak;
}
