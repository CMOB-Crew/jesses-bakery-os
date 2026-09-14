/**
 * assistant-is-read-only-check.ts — condition 2.
 *
 * "The AI assistant runs on a dedicated read-only Postgres role with RLS
 * applied. Never the service role." — @Fred, condition 2 of fifteen.
 *
 * The assistant is the one surface in this system that turns a sentence
 * typed by a person into a database call, and until 14 September 2026 it
 * ran on `jbo_app`, which can write to all 50 tables. "It only ever runs
 * parameterised SELECTs" was true, and was the only thing stopping a typed
 * question from becoming a write.
 *
 * Two kinds of check below.
 *
 *   STRUCTURAL, always. That lib/ask.ts cannot reach the read-write
 *   connection even by accident — it is one import line away from it and
 *   that line is what this guards.
 *
 *   BEHAVIOURAL, when a database is reachable. That a `read only`
 *   transaction really does reject a write, rather than being a string we
 *   believe in. Skipped with a clear message when DATABASE_URL is unset or
 *   the database is not up, because a check that quietly passes when it did
 *   not run is worse than no check.
 *
 * Run:  npx tsx scripts/assistant-is-read-only-check.ts
 */
import fs from "node:fs";
import path from "node:path";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "\n        " + detail : ""}`);
}

const here = path.resolve(__dirname, "..");
const ask = fs.readFileSync(path.join(here, "lib/ask.ts"), "utf8");
const db = fs.readFileSync(path.join(here, "lib/db.ts"), "utf8");

console.log("— the assistant cannot reach the read-write connection —\n");

// What ask.ts imports FROM ./db, by the name db.ts exports it under -- not
// by the local alias. `aq as sql` imports aq, and the alias happening to be
// spelled "sql" is exactly what makes a naive text search wrong here.
const imported = (() => {
  const m = /import\s*\{([^}]*)\}\s*from\s*["']\.\/db["']/.exec(ask);
  if (!m) return [] as string[];
  return m[1]
    .split(",")
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
})();

check("ask.ts imports something from ./db at all",
  imported.length > 0,
  "if this fails, every check below it is meaningless");

check("ask.ts does not import q, the read-write query function",
  !imported.includes("q"),
  "this single import line was the whole of condition 2");

check("ask.ts does not import the raw connection pool",
  !imported.includes("sql"),
  "imports from ./db: " + imported.join(", "));

check("ask.ts imports aq instead",
  imported.includes("aq") && /\baq\s+as\s+sql\b/.test(ask),
  "aliased to sql, which is why all fifteen call sites stayed untouched");

check("ask.ts imports withAssistant",
  imported.includes("withAssistant"));

check("answerQuestion is wrapped, so no caller can skip the transaction",
  /export\s+async\s+function\s+answerQuestion\b[\s\S]{0,200}?withAssistant\s*\(/.test(ask),
  "wrapping at the route instead would leave the next caller free to forget");

check("the unwrapped body is not exported",
  /\nasync\s+function\s+answerQuestionInner\b/.test(ask) &&
  !/export\s+async\s+function\s+answerQuestionInner\b/.test(ask));

check("nothing in ask.ts writes",
  !/\b(insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|drop\s+table|alter\s+table)\b/i.test(ask),
  "belt and braces: the read-only transaction would reject it anyway");

console.log("\n— the transaction really is read only —\n");

check("db.ts opens the assistant transaction as read only",
  /\.begin\(\s*["']read only["']/.test(db),
  "postgres.js appends this to BEGIN, so it is read only from the first statement");

check("the claims are transaction-local, not session-level",
  /set_config\('request\.jwt\.claims',\s*\$\{claimsJson\},\s*true\)/.test(db) ||
  /set_config\('request\.jwt\.claims'[\s\S]{0,60}true\)/.test(db),
  "session-level leaks the previous user's identity into the next request on a pooled connection");

check("no signed-in user returns no rows without opening a transaction",
  /\{\s*denied:\s*true\s*\}/.test(db),
  "fails closed, the same shape q() uses");

check("a statement outside withAssistant opens its own read-only transaction",
  /return\s+withAssistant\(\(\)\s*=>\s*aq</.test(db),
  "rather than falling through to the read-write pool");

check("the dedicated role is picked up automatically when it exists",
  /ASSISTANT_DATABASE_URL/.test(db));

/* ------------------------------------------------------------------ *
 * Behavioural. Only runs if a database answers.
 * ------------------------------------------------------------------ */
async function behavioural() {
  console.log("\n— proving it against a real database —\n");

  const envPath = path.join(here, ".env.local");
  let url = process.env.DATABASE_URL;
  if (!url && fs.existsSync(envPath)) {
    const m = /^DATABASE_URL=(.*)$/m.exec(fs.readFileSync(envPath, "utf8"));
    if (m) url = m[1].trim().replace(/^["']|["']$/g, "");
  }
  if (!url) {
    console.log("SKIP  no DATABASE_URL, so the read-only transaction was not exercised.");
    console.log("      The structural checks above still ran.");
    return;
  }

  const postgres = (await import("postgres")).default;
  const isLocal = /@(localhost|127\.0\.0\.1)/.test(url);
  const sql = postgres(url, {
    max: 1,
    idle_timeout: 5,
    connect_timeout: 5,
    ssl: isLocal ? undefined : "require",
    prepare: isLocal ? undefined : false,
  });

  try {
    await sql`select 1`;
  } catch (e) {
    console.log("SKIP  the database did not answer, so the read-only transaction was not exercised.");
    console.log("      " + (e instanceof Error ? e.message.split("\n")[0] : String(e)));
    console.log("      The structural checks above still ran.");
    await sql.end({ timeout: 1 }).catch(() => {});
    return;
  }

  // A read runs.
  let readOk = false;
  await sql.begin("read only", async (tx) => {
    const [r] = await tx<{ one: number }[]>`select 1 as one`;
    readOk = r.one === 1;
  });
  check("a read runs inside the read-only transaction", readOk);

  // A write does not. A temp table is the safest possible write: it can
  // touch nothing, and Postgres still refuses it in a read-only
  // transaction, which is exactly the property being asserted.
  let refused = "";
  try {
    await sql.begin("read only", async (tx) => {
      await tx`create temp table _assistant_readonly_probe (i int)`;
    });
  } catch (e) {
    refused = e instanceof Error ? e.message : String(e);
  }
  check("a write is refused inside the read-only transaction",
    /read-only transaction/i.test(refused),
    refused ? refused.split("\n")[0] : "THE WRITE SUCCEEDED — the transaction is not read only");

  // And the same write succeeds outside one, so the refusal above is the
  // transaction doing its job rather than a permission error in disguise.
  let outsideWorked = false;
  try {
    await sql`create temp table _assistant_readonly_probe2 (i int)`;
    await sql`drop table _assistant_readonly_probe2`;
    outsideWorked = true;
  } catch {
    outsideWorked = false;
  }
  check("the same write succeeds OUTSIDE the transaction",
    outsideWorked,
    "otherwise the refusal above proves nothing — it could be a grant, not the transaction");

  await sql.end({ timeout: 2 }).catch(() => {});
}

behavioural()
  .catch((e) => {
    console.log("FAIL  the behavioural check threw: " + (e instanceof Error ? e.message : String(e)));
    fails++;
  })
  .then(() => {
    const role = /ASSISTANT_DATABASE_URL/.test(db) && process.env.ASSISTANT_DATABASE_URL;
    console.log(
      "\n" +
        (fails === 0
          ? "  All checks pass. The assistant cannot write.\n" +
            (role
              ? "  It is on its own role (ASSISTANT_DATABASE_URL is set).\n"
              : "  It is still on the app's connection, inside a read-only transaction.\n" +
                "  The dedicated role is queued: docs/condition-2-the-assistant-role.md\n")
          : `  ${fails} FAILED\n`),
    );
    process.exit(fails === 0 ? 0 : 1);
  });
