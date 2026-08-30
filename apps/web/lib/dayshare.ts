// One weekday-split rule, shared by the Deliveries sheet and the Packing sheet.
//
// It lived inside DeliveriesBoard as a local dv() plus a local SEED_DOWMULT.
// Packing now needs the identical rule to size a standing order for one day,
// and copying it would have been the third time this build shipped one rule
// written twice -- after safeNext, where an open redirect existed precisely
// because the check was written out three times and verified once, and
// NotFoundPanel.
//
// The rule: a store's weekly total is divided across ONLY that store's own
// delivery days, weighted by the demand curve, so Saturday sits at the top of
// its range and Tuesday near the bottom -- and a day it is not delivered gets
// nothing rather than an invented number.

export const WD_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// Fallback week-shape (Mon..Sun) -- quieter Mon/Tue, heavy Fri-Sun. Used only
// until there is a measured shape; splits the weekly plan into a single day's
// drop while the weekly totals stay exact.
export const SEED_DOWMULT = [0.85, 0.85, 0.95, 1, 1.3, 1.55, 1.4];

// Measured from real sell-through when we have it, reindexed from the Sun..Sat
// shape getWeekdayShape returns; else the seed curve. Same curve the
// Seasonality calendar draws -- one shape across the app.
export function dowMultipliers(shape?: { shape: number[] } | null): number[] {
  return shape?.shape ? [1, 2, 3, 4, 5, 6, 0].map((i) => shape.shape[i]) : SEED_DOWMULT;
}

// A store's share of its weekly total on one day. dayIdx is Monday=0, matching
// WD_ORDER.
//
// Returns 0 when the store's days are unknown, or it is not delivered that day.
// The seven invoice cafes Simona left blank are exactly the first case, and
// inventing a Tuesday drop for them is worse than admitting we do not know.
export function dayShare(weekTotal: number, storeDays: string[], dayIdx: number, mult: number[]): number {
  if (!storeDays || storeDays.length === 0) return 0;
  if (!storeDays.includes(WD_ORDER[dayIdx])) return 0;
  const wsum = storeDays.reduce((a, d) => {
    const j = WD_ORDER.indexOf(d);
    return a + (j >= 0 ? mult[j] : 0);
  }, 0);
  return wsum > 0 ? Math.round((weekTotal * mult[dayIdx]) / wsum) : 0;
}

// Monday=0 index for a plain YYYY-MM-DD, built at UTC so no timezone can shift
// it a day either way -- the same care app/packing/page.tsx takes over dayLabel.
export function dayIndexFromISO(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return 0;
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}
