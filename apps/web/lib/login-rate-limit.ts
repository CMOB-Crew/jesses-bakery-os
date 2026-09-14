/* ------------------------------------------------------------------ *
 * Condition 7: five attempts a minute, per identifier, logged.
 *
 * Until 14 September there was no limiter at all, and that morning six
 * drivers were given BDriver<nn>! -- a hundred possibilities on a pattern
 * every driver knows, because every driver has one. With no limiter those
 * hundred guesses were free, which means one driver could sign in as
 * another. saveDeliveryProof stamps deliveries.driver_sig_name from the
 * session, so that is not just an account, it is whose name ends up on a
 * proof of delivery.
 *
 * THE DECISION IS PURE, THE COUNTING IS NOT.
 *
 * Everything that decides whether to allow an attempt is in `decide()` and
 * takes a number. The database work is separate, so the rule can be asserted
 * exhaustively in a script and the wiring can be read in one screen.
 *
 * FOUR CHOICES WORTH STATING, BECAUSE EACH COULD REASONABLY HAVE GONE THE
 * OTHER WAY.
 *
 * 1. ONLY FAILURES COUNT. The condition says "five attempts". Counting
 *    successes as well would lock out a driver who signs in on two phones and
 *    a tablet, and it protects nothing: an attacker's guesses fail by
 *    definition. Successes are still RECORDED, because the log is the other
 *    half of the condition and "who got in, and when" is the half a person
 *    actually reads.
 *
 * 2. PER IDENTIFIER, NOT PER IP. The condition's own wording, and it is the
 *    right call here: the bakery is behind one connection, so an IP limit
 *    would lock out the whole floor the moment two drivers mistype. The IP is
 *    recorded for forensics and is not what the limit is keyed on.
 *
 * 3. IT FAILS OPEN. If the database cannot be reached, the attempt is
 *    allowed. A limiter that fails closed locks every driver out of the app
 *    at 4am because of a connection blip, which is a worse outage than the
 *    thing it is defending against. It is the uncomfortable choice and it is
 *    made loudly: a failure to check is logged to the function log, because
 *    a control that has silently stopped is the failure mode this codebase
 *    keeps finding.
 *
 * 4. THE MESSAGE NEVER SAYS WHETHER THE ACCOUNT EXISTS. requestPasswordReset
 *    already goes out of its way not to leak that -- it ignores its own
 *    result so nobody can enumerate who works here. A limiter that said "too
 *    many attempts for that address" would undo it in one line, so the block
 *    message is identical whether or not the identifier is real.
 * ------------------------------------------------------------------ */

/** The condition, verbatim: five per minute per identifier. */
export const MAX_FAILURES = 5;
export const WINDOW_SECONDS = 60;

/**
 * Kept for a day, not forever.
 *
 * The limiter only ever reads the last sixty seconds. A day is so a person
 * can look at yesterday, and it is bounded ON PURPOSE: condition 8 is unmet
 * precisely because nothing purges anything, and a row per login attempt per
 * person per day is exactly that shape. The purge runs on the write path
 * rather than as a scheduled job nobody sets up.
 */
export const KEEP_HOURS = 24;

export type Decision = {
  allowed: boolean;
  /** Shown to the person. Identical whether or not the identifier exists. */
  says: string;
  /** Seconds until they could try again, for the message. */
  retryAfterSeconds: number;
};

/**
 * The whole rule, as one function of one number.
 *
 * `failuresInWindow` is how many FAILED attempts this identifier has made in
 * the last WINDOW_SECONDS. Successes are not passed in; see choice 1 above.
 */
export function decide(failuresInWindow: number): Decision {
  if (failuresInWindow < MAX_FAILURES) {
    return { allowed: true, says: "", retryAfterSeconds: 0 };
  }
  return {
    allowed: false,
    // No mention of the address, of whether it exists, or of how many
    // attempts remain. "Too many attempts" and a number of seconds is
    // everything a legitimate person needs and nothing an attacker can use.
    says: `Too many attempts. Wait a minute and try again.`,
    retryAfterSeconds: WINDOW_SECONDS,
  };
}

/**
 * The bucket an attempt counts against.
 *
 * Lowercased and trimmed, because "Sam@" and " sam@" being separate buckets
 * would make the limit bypassable by holding down shift or fumbling a space.
 */
export function bucketFor(email: string): string {
  return email.trim().toLowerCase();
}

export type AttemptKind = "signin" | "reset";
export type AttemptOutcome = "failed" | "blocked" | "ok";

export type LimiterStore = {
  /** FAILED attempts for this bucket inside the window. Never counts 'ok'. */
  countFailures(identifier: string, windowSeconds: number): Promise<number>;
  record(row: {
    identifier: string;
    kind: AttemptKind;
    outcome: AttemptOutcome;
    ip: string | null;
  }): Promise<void>;
  /** Bounded on the write path, so this table cannot become condition 8. */
  purgeOlderThan(hours: number): Promise<void>;
};

/**
 * Ask before trying. Returns the decision and records a block when it blocks,
 * so a blocked attempt is in the log rather than invisible.
 *
 * Never throws. A store that is unreachable returns `allowed`, because the
 * alternative is locking the floor out of the app over a connection blip --
 * see choice 3. The failure is written to the function log, which is the only
 * place left to write it when the database is the thing that is down.
 */
export async function checkBeforeAttempt(
  store: LimiterStore,
  email: string,
  kind: AttemptKind,
  ip: string | null,
): Promise<Decision> {
  const identifier = bucketFor(email);
  let failures: number;
  try {
    failures = await store.countFailures(identifier, WINDOW_SECONDS);
  } catch (e) {
    console.error(
      "[login-rate-limit] could not read the attempt log, so this attempt was ALLOWED unchecked. " +
        "Condition 7 is not being enforced right now. " +
        (e instanceof Error ? e.message : String(e)),
    );
    return { allowed: true, says: "", retryAfterSeconds: 0 };
  }

  const d = decide(failures);
  if (!d.allowed) {
    // Recorded, but deliberately NOT counted toward the limit on the next
    // pass -- only 'failed' rows count. Otherwise one person hammering the
    // button would extend their own lockout indefinitely, which turns a
    // one-minute limit into a denial of service against themselves.
    await store.record({ identifier, kind, outcome: "blocked", ip }).catch(() => {});
  }
  return d;
}

/**
 * Record the outcome once the attempt has actually been made.
 *
 * Separate from the check on purpose: the check happens before Supabase is
 * asked anything, and the outcome is only known afterwards. Folding them
 * together would mean either counting an attempt that never happened or
 * missing one that did.
 */
export async function recordOutcome(
  store: LimiterStore,
  email: string,
  kind: AttemptKind,
  outcome: Exclude<AttemptOutcome, "blocked">,
  ip: string | null,
): Promise<void> {
  const identifier = bucketFor(email);
  try {
    await store.record({ identifier, kind, outcome, ip });
    // Cheap, bounded, and on the write path so it cannot be forgotten.
    await store.purgeOlderThan(KEEP_HOURS);
  } catch (e) {
    console.error(
      "[login-rate-limit] could not write to the attempt log. The limit is not " +
        "being counted for this attempt. " + (e instanceof Error ? e.message : String(e)),
    );
  }
}
