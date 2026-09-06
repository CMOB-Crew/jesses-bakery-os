/* ---------------------------------------------------------------------------
 * Why a driver's screen is empty, and how to say so honestly.
 *
 * THE PROBLEM THIS EXISTS TO FIX.
 *
 * When getPackingRuns() comes back with nothing, the Driver app falls back to
 * eight sample stops -- Coles Bondi Junction, Woolworths Bondi Beach, Harris
 * Farm Rose Bay -- with plausible quantities, three of them already marked
 * delivered and one marked "next". Above them sat a single amber line:
 *
 *     "No plan for today, so these are sample stops. Nothing you tap is saved."
 *
 * Two things wrong with that.
 *
 * FIRST, IT IS A GUESS STATED AS A FACT. "No plan for today" is one of four
 * possible reasons the list came back empty, and after the RLS flip it is the
 * LEAST likely one. Every row-level security failure in this build has looked
 * identical -- no error, no log line, just zero rows -- so the most probable
 * cause of an empty run on go-live morning is that the plan is there and this
 * phone cannot read it. The banner would confidently tell the driver the
 * opposite, and the office would go looking at the engine instead of the
 * policies.
 *
 * SECOND, THE RUNBOOK'S OWN CHECK IS DEFEATED BY IT. Step 6 of the flip
 * runbook says: driver opens /driver, expect a run WITH STOPS IN IT, because an
 * empty run is the 075/078 failure shape. But it never looks empty. It looks
 * like a full working run of real Sydney stores, at 4am, on a phone, with one
 * amber line above it. Somebody doing that check in a hurry ticks it off.
 *
 * WHAT THIS DOES INSTEAD. Four counts, all read inside the driver's own
 * permissions, turn the guess into a measurement:
 *
 *   totalStores  -- the store list at all, unfiltered. A driver is granted
 *                   SELECT on stores by migration 078, so zero here does not
 *                   mean the bakery has no stores. It means this phone cannot
 *                   read them, and nothing else the screen says can be trusted.
 *   storesDue    -- stores that take a delivery on this weekday.
 *   planRows     -- what the engine sized for this exact date.
 *
 * The order of the checks matters and is not arbitrary: each one is only
 * meaningful if the one before it came back non-zero. Read top to bottom.
 * --------------------------------------------------------------------------- */

export type DriverDayCounts = {
  totalStores: number;
  storesDue: number;
  planRows: number;
  /** The counts query itself threw, rather than returning zeroes. */
  unreadable: boolean;
};

export type DriverDayMode =
  | "live"          // there are stops; nothing to explain
  | "demo"          // nobody signed in -- a walkthrough, sample stops are fine
  | "unreadable"    // the check itself failed
  | "no-access"     // signed in, but cannot read the store list
  | "rest-day"      // no store takes a delivery today
  | "plan-missing"  // stores are due, the engine planned nothing
  | "not-reaching"; // the plan exists and none of it reached this phone

/**
 * Sample stops are shown for exactly one reason: walking somebody through the
 * flow when there is no data. That is a demo, and a demo has nobody signed in.
 *
 * A signed-in driver on a live system must never be shown a fabricated run. It
 * is a convincing list of real store names they could drive to, and nothing
 * they tap on it is saved.
 */
export function showsSampleStops(mode: DriverDayMode): boolean {
  return mode === "demo";
}

export function driverDayMode(
  hasRuns: boolean,
  signedIn: boolean,
  counts: DriverDayCounts | null,
): DriverDayMode {
  if (hasRuns) return "live";
  if (!signedIn) return "demo";
  if (!counts || counts.unreadable) return "unreadable";
  if (counts.totalStores === 0) return "no-access";
  if (counts.storesDue === 0) return "rest-day";
  if (counts.planRows === 0) return "plan-missing";
  return "not-reaching";
}

/**
 * The one-line version, for the amber strip at the top of the phone.
 *
 * The strip and the empty state are both on screen at once, so they must not
 * be the same sentence twice -- that reads as a page that has printed itself
 * wrong. The strip says WHAT, in a glance; driverDayNote() below says what to
 * do about it, in the body where there is room.
 */
export function driverDayBanner(mode: DriverDayMode, dayLabel: string): string | null {
  switch (mode) {
    case "live":         return null;
    case "demo":         return "Sample stops. Nothing you tap is saved.";
    case "rest-day":     return `No deliveries scheduled for ${dayLabel}.`;
    case "plan-missing": return `${dayLabel}'s run has not been built yet.`;
    case "not-reaching": return `${dayLabel}'s run is not reaching this phone.`;
    case "no-access":    return "This account cannot see any stores.";
    case "unreadable":   return "Could not load today's run.";
  }
}

/**
 * The body version, shown where the stop list would be. Written to be read on a
 * phone, in a van, by somebody who is already behind -- so: what is true, then
 * what to do about it. No mention of row-level security, engines or
 * plans-versus-recos; those are our words, not theirs.
 */
export function driverDayNote(mode: DriverDayMode, dayLabel: string): string | null {
  switch (mode) {
    case "live":
      return null;
    case "demo":
      return "Sample stops, for showing how the app works. Nothing you tap is saved.";
    case "rest-day":
      return `No deliveries scheduled for ${dayLabel}. Nothing to run today — if that looks wrong, call the bakery.`;
    case "plan-missing":
      return `Stores are due today but ${dayLabel}'s run has not been built yet. Call the bakery before you set off — do not guess the quantities.`;
    case "not-reaching":
      return `${dayLabel}'s run exists but none of it has reached this phone. This is a fault, not an empty day. Call the bakery and tell them the driver app is showing no stops.`;
    case "no-access":
      return "This account cannot see any stores, so nothing on this screen can be trusted. Call the bakery and tell them the driver app has no access.";
    case "unreadable":
      return "Could not load today's run. Check your signal and pull down to refresh. If it stays empty, call the bakery.";
  }
}

/* ---------------------------------------------------------------------------
 * THE PACKING SHEET USES THE SAME DECISION TREE, BECAUSE IT IS THE SAME FAILURE.
 *
 * The sheet already refuses to invent data -- it has always shown an honest
 * "Nothing to pack on Monday" panel rather than sample stores. But it offered
 * two reasons and both were benign:
 *
 *     "No run delivers on this day, or the plan does not reach it yet."
 *
 * Neither is the one that matters. A packer standing at the bench at 4am on
 * go-live morning, reading that while 144 stores are due, goes home. Then the
 * bakery does not bake. That is the most expensive single failure in this
 * system, and it is one row-level security policy away.
 *
 * Migration 078 grants a packer SELECT on stores and replenishment_plans, the
 * same as a driver, so the same three counts answer it.
 *
 * Only the words change, because the room is different: a packer IS at the
 * bakery, so "call the bakery" is nonsense to them, and there is no van to be
 * held up. What they need is permission to stop and a name to raise.
 * --------------------------------------------------------------------------- */

/** The heading on the packing sheet's empty panel. */
export function packingDayHeading(mode: DriverDayMode, dayLabel: string): string {
  switch (mode) {
    case "rest-day":
      return `Nothing to pack on ${dayLabel}`;
    case "live":
    case "demo":
      return `Nothing to pack on ${dayLabel}`;
    default:
      return `The sheet for ${dayLabel} is empty, and it should not be`;
  }
}

export function packingDayNote(mode: DriverDayMode, dayLabel: string): string {
  switch (mode) {
    case "rest-day":
      return `No run delivers on ${dayLabel}. Pick another day above to see its sheet.`;
    case "plan-missing":
      return "Stores are due a delivery today, but tonight's plan was never built. Do not pack from memory or from yesterday's sheet — tell Simona or Jesse before anything goes in a tray.";
    case "not-reaching":
      return "Stores are due today and the plan exists, but none of it is reaching this screen. This is a fault, not a quiet day. Tell Simona or Jesse now — do not start packing from another source.";
    case "no-access":
      return "This account cannot see any stores, so an empty sheet proves nothing. Tell Simona or Jesse that the packing screen has no access.";
    case "unreadable":
      return "The sheet could not be loaded. Refresh once; if it is still empty, tell Simona or Jesse rather than packing from another source.";
    // Reached when nothing is planned and there is nothing to diagnose -- the
    // plan legitimately does not extend this far. The engine plans twelve days
    // ahead and rewrites them nightly.
    default:
      return "No run delivers on this day, or the plan does not reach it yet. The engine plans twelve days ahead and rewrites them nightly.";
  }
}
