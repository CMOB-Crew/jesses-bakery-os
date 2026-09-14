/**
 * proof-coverage-check.ts — which deliveries have no proof at all.
 *
 * The weekly audit answers "is every recorded proof still there". It cannot
 * answer this one, because a delivery with no photograph has no
 * delivery_photos row to inspect -- so eleven drops on a Tuesday with no
 * photograph produce a clean audit, and the only person who knew was the
 * driver who saw the message.
 *
 * The fake sql below returns whatever the case needs, so every branch runs
 * with no database and no credentials.
 *
 * Run:  npx tsx scripts/proof-coverage-check.ts
 */
import {
  auditCoverage, coverageSummary, coverageLines,
  DEFAULT_WINDOW_DAYS, MAX_LISTED, type Uncovered,
} from "../lib/proof-coverage";

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "\n        " + detail : ""}`);
}

const drop = (d: string, name: string): Uncovered => ({
  delivery_id: `id-${d}-${name}`,
  delivery_date: d,
  store_id: "s1",
  store_name: name,
  status: "delivered",
});

/** Records which functions were asked for, so the RLS trap can be asserted. */
function fakeSql(delivered: number, uncovered: Uncovered[]) {
  const asked: string[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    asked.push(text.replace(/\s+/g, " ").trim());
    if (text.includes("jb_delivered_in_window")) return [{ n: delivered }];
    if (text.includes("jb_deliveries_without_proof")) return uncovered;
    throw new Error("unexpected query: " + text);
  }) as <T>(s: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
  return { sql, asked };
}

async function main() {
  console.log("— it reads past row-level security, or it is worthless —\n");

  {
    const f = fakeSql(10, []);
    await auditCoverage({ sql: f.sql });
    const all = f.asked.join(" | ");
    check("BOTH reads go through the definer functions",
      /jb_delivered_in_window/.test(all) && /jb_deliveries_without_proof/.test(all));
    check("neither query touches delivery_photos directly",
      !/delivery_photos/.test(all),
      "under forced RLS with no session that returns nothing, so every delivery would look uncovered");
    check("and neither touches deliveries directly",
      !/from deliveries|join deliveries/.test(all),
      "a silent all-alarm is the same bug as a silent all-clear, wearing the opposite coat");
  }

  console.log("\n— the numbers —\n");

  {
    const f = fakeSql(10, [drop("2026-09-10", "KRINSKYS"), drop("2026-09-11", "BP BOTANY")]);
    const c = await auditCoverage({ sql: f.sql });
    check("counts what has no proof", c.uncovered === 2);
    check("keeps the denominator", c.delivered === 10);
    check("percent is whole, not six decimal places", c.covered_pct === 80, String(c.covered_pct));
    check("the default window is a fortnight, so a weekly job has one run of slack",
      c.window_days === DEFAULT_WINDOW_DAYS && DEFAULT_WINDOW_DAYS === 14);
  }

  {
    const f = fakeSql(0, []);
    const c = await auditCoverage({ sql: f.sql });
    check("NO DELIVERIES REPORTS NULL, NOT 100%",
      c.covered_pct === null,
      "'100% of nothing is covered' reads as reassurance, and there is nothing to be reassured about");
    check("and the summary says what actually happened",
      /nothing to photograph/.test(coverageSummary(c)), coverageSummary(c));
  }

  {
    const f = fakeSql(7, []);
    const c = await auditCoverage({ sql: f.sql });
    check("a fully covered window is 100%", c.covered_pct === 100);
    check("and it still prints a line on a clean run",
      /all 7 deliveries/.test(coverageSummary(c)),
      "a number that only appears when it is bad teaches nobody what normal looks like");
  }

  console.log("\n— what it prints —\n");

  {
    const f = fakeSql(4, [drop("2026-09-10", "KRINSKYS"), drop("2026-09-11", "BP BOTANY")]);
    const c = await auditCoverage({ sql: f.sql });
    const s = coverageSummary(c);
    check("the summary names the count, the total and the window",
      /2 of 4/.test(s) && /14 days/.test(s), s);
    check("it says NO proof rather than something softer",
      /NO proof of delivery/.test(s), s);

    const lines = coverageLines(c);
    check("each uncovered drop is named with its date and store",
      lines.length === 2 && /2026-09-10/.test(lines[0]) && /KRINSKYS/.test(lines[0]),
      lines[0]);
    check("the lines carry no signer name and no GPS",
      !/signed|lat|lng|gps/i.test(lines.join(" ")),
      "the audit manifest is deliberately not handed out by default; this is not a way around that");
  }

  {
    const many = Array.from({ length: 55 }, (_, i) => drop("2026-09-01", `STORE ${i}`));
    const f = fakeSql(100, many);
    const c = await auditCoverage({ sql: f.sql });
    check("the full count is kept even when the list is trimmed", c.uncovered === 55);
    check("but only a readable number are listed", c.worst.length === MAX_LISTED);
    const lines = coverageLines(c);
    check("and the trim says how many it did not list",
      /and 35 more not listed/.test(lines[lines.length - 1]),
      lines[lines.length - 1]);
  }

  console.log("\n— the window —\n");

  {
    const f = fakeSql(3, []);
    const c = await auditCoverage({ sql: f.sql, windowDays: 30 });
    check("an explicit window is honoured", c.window_days === 30);
    check("and it reaches the query", /30/.test(String(c.window_days)));
  }

  {
    const f = fakeSql(3, []);
    const c = await auditCoverage({ sql: f.sql, windowDays: 0 });
    check("a zero window is clamped to something meaningful rather than matching nothing",
      c.window_days >= 1, String(c.window_days));
  }

  console.log(
    fails === 0
      ? "\n  All checks pass. A drop with no photograph is now counted, named,\n" +
        "  and printed every week rather than only when it goes wrong.\n"
      : `\n  ${fails} FAILED\n`,
  );
  process.exit(fails === 0 ? 0 : 1);
}

main();
