// Where a driver licence photograph lives in the bucket, and nothing else.
//
// This is its own file because the shape is written down TWICE otherwise -- the
// route builds it, the save action checks it -- and those two are the only
// thing standing between a phone and naming an object of its choosing. Two
// copies of a security check in two files drift, and the drift is silent: the
// check still passes, it just stops matching what is issued.
//
// No imports, no environment, no crypto. Pure enough to test without a server.

export const LICENCE_PREFIX = "licence";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(day: string): boolean {
  return DAY.test(day);
}

/** The object name for one licence. `id` is a uuid the SERVER generates. */
export function licencePath(day: string, id: string): string {
  return `${LICENCE_PREFIX}/${day}/${id}.jpg`;
}

/**
 * Is this a path we issued, for this day?
 *
 * Anchored at both ends, which is the whole point: an unanchored test would
 * accept "../../feeds/coles/licence/2026-09-14/<uuid>.jpg" and let a phone
 * write a row pointing anywhere in the bucket. The uuid class is deliberately
 * [0-9a-f-] only, so a path segment cannot carry a slash, a dot or a space.
 */
export function isLicencePath(day: string, path: string): boolean {
  if (!isDay(day)) return false;
  return new RegExp(`^${LICENCE_PREFIX}/${day}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.jpg$`, "i")
    .test(path);
}
