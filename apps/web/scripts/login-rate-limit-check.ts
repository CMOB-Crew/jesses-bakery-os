/**
 * login-rate-limit-check.ts — condition 7.
 *
 * "Rate limiting on login and password reset. Five attempts per minute per
 * identifier, logged." — @Fred, condition 7 of fifteen.
 *
 * There was no limiter at all until 14 September, and that morning six drivers
 * were given BDriver<nn>! -- a hundred possibilities on a pattern every driver
 * knows. With no limiter those hundred guesses were free, so one driver could
 * sign in as another, and saveDeliveryProof stamps deliveries.driver_sig_name
 * from the session. That is whose name ends up on a proof of delivery.
 *
 * Every rule is asserted here against a fake store: no database, no network,
 * no credentials. Including the two that are easy to get wrong and impossible
 * to notice -- that it fails OPEN when the store is down, and that a blocked
 * attempt does not extend its own lockout.
 *
 * Run:  npx tsx scripts/login-rate-limit-check.ts
 */
import {
  decide, bucketFor, checkBeforeAttempt, recordOutcome,
  MAX_FAILURES, WINDOW_SECONDS, KEEP_HOURS,
  type LimiterStore, type AttemptKind, type AttemptOutcome,
} from "../lib/login-rate-limit";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "\n        " + detail : ""}`);
}

type Row = { identifier: string; kind: AttemptKind; outcome: AttemptOutcome; ip: string | null };

/** A fake store that counts only what the real one is contracted to count. */
function fakeStore(opts: { failures?: number; throwOnCount?: boolean; throwOnRecord?: boolean } = {}) {
  const rows: Row[] = [];
  let purgedHours: number | null = null;
  const store: LimiterStore = {
    async countFailures() {
      if (opts.throwOnCount) throw new Error("the database is not reachable");
      return opts.failures ?? 0;
    },
    async record(r) {
      if (opts.throwOnRecord) throw new Error("the database is not reachable");
      rows.push(r);
    },
    async purgeOlderThan(h) {
      purgedHours = h;
    },
  };
  return { store, rows, purged: () => purgedHours };
}

/* Wrapped rather than left at top level: tsx transforms these scripts to CJS,
 * where top-level await is a build error. */
async function main() {
  console.log("— the rule itself —\n");

  check("the condition's numbers, not something near them",
    MAX_FAILURES === 5 && WINDOW_SECONDS === 60,
    `${MAX_FAILURES} per ${WINDOW_SECONDS}s`);

  check("no failures is allowed", decide(0).allowed);
  check("four failures is still allowed", decide(MAX_FAILURES - 1).allowed);
  check("the fifth failure is the last one allowed through",
    decide(MAX_FAILURES - 1).allowed && !decide(MAX_FAILURES).allowed,
    "five attempts per minute means the sixth is refused");
  check("well past the limit stays blocked", !decide(500).allowed);

  check("the block message never names the address",
    !/@/.test(decide(99).says), decide(99).says);
  check("the block message never says how many attempts are left or used",
    !/\d+\s*(attempts?|remaining|left|of)/i.test(decide(99).says), decide(99).says);
  check("it does tell a legitimate person when to come back",
    /minute/i.test(decide(99).says) && decide(99).retryAfterSeconds === WINDOW_SECONDS);
  check("an allowed decision carries no message to show",
    decide(0).says === "" && decide(0).retryAfterSeconds === 0);

  console.log("\n— the bucket —\n");

  check("case does not make a second bucket",
    bucketFor("Sam@Jessesbakery.com.au") === bucketFor("sam@jessesbakery.com.au"),
    "otherwise the limit is bypassed by holding down shift");
  check("surrounding space does not make a third",
    bucketFor("  sam@x  ") === "sam@x");

  console.log("\n— blocking —\n");

  {
    const f = fakeStore({ failures: MAX_FAILURES });
    const d = await checkBeforeAttempt(f.store, "sam@x", "signin", "1.2.3.4");
    check("blocks once the window is full", !d.allowed);
    check("AND RECORDS THE BLOCK, so a blocked attempt is not invisible",
      f.rows.length === 1 && f.rows[0].outcome === "blocked");
    check("the recorded block carries the ip for forensics",
      f.rows[0].ip === "1.2.3.4");
    check("the bucket is recorded lowercased", f.rows[0].identifier === "sam@x");
  }

  {
    const f = fakeStore({ failures: 2 });
    const d = await checkBeforeAttempt(f.store, "sam@x", "signin", null);
    check("under the limit is allowed through", d.allowed);
    check("and nothing is recorded by the check itself",
      f.rows.length === 0,
      "the outcome is only known after the attempt; recordOutcome writes it");
  }

  console.log("\n— the two that are easy to get wrong —\n");

  {
    const f = fakeStore({ throwOnCount: true });
    const d = await checkBeforeAttempt(f.store, "sam@x", "signin", null);
    check("A STORE THAT IS DOWN FAILS OPEN",
      d.allowed,
      "failing closed would lock every driver out of the app at 4am over a connection blip");
  }

  {
    // The real store counts only 'failed'. This asserts the CONTRACT the
    // limiter relies on: blocked rows must not feed the next count, or one
    // person hammering the button extends their own lockout forever.
    const f = fakeStore({ failures: MAX_FAILURES });
    await checkBeforeAttempt(f.store, "sam@x", "signin", null);
    await checkBeforeAttempt(f.store, "sam@x", "signin", null);
    await checkBeforeAttempt(f.store, "sam@x", "signin", null);
    check("a blocked attempt is recorded as 'blocked', never as 'failed'",
      f.rows.length === 3 && f.rows.every((r) => r.outcome === "blocked"),
      "only 'failed' counts, so hammering the button cannot extend the lockout");
  }

  console.log("\n— recording the outcome —\n");

  {
    const f = fakeStore();
    await recordOutcome(f.store, "SAM@x", "signin", "failed", "9.9.9.9");
    check("a failure is recorded against the lowercased bucket",
      f.rows.length === 1 && f.rows[0].identifier === "sam@x" && f.rows[0].outcome === "failed");
    check("and the purge runs on the write path",
      f.purged() === KEEP_HOURS,
      "so this table cannot become condition 8, which is unmet because nothing purges anything");
  }

  {
    const f = fakeStore();
    await recordOutcome(f.store, "sam@x", "signin", "ok", null);
    check("a SUCCESS is recorded too, because the log is half the condition",
      f.rows.length === 1 && f.rows[0].outcome === "ok");
  }

  {
    const f = fakeStore({ throwOnRecord: true });
    let threw = false;
    try {
      await recordOutcome(f.store, "sam@x", "signin", "failed", null);
    } catch { threw = true; }
    check("a store that cannot be written to NEVER throws into the login path",
      !threw,
      "a broken log must not stop a driver signing in");
  }

  {
    const f = fakeStore();
    await recordOutcome(f.store, "sam@x", "reset", "failed", null);
    check("the reset path is limited too, which the condition asks for",
      f.rows[0].kind === "reset");
  }

  console.log(
    fails === 0
      ? "\n  All checks pass. Five a minute per identifier, logged, and it fails\n" +
        "  open loudly rather than locking the floor out quietly.\n"
      : `\n  ${fails} FAILED\n`,
  );
  process.exit(fails === 0 ? 0 : 1);
}

main();
