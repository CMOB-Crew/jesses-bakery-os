/**
 * feed-alarm-check.ts — what the feed alarm says, in every state.
 *
 * The bar cannot be checked by looking at production, because production is
 * healthy: all three feeds are one day behind, which is what "ok" means and
 * which is exactly when the bar must NOT appear. So the copy is asserted
 * here instead, against the states that matter -- including the silent one,
 * which is the case most likely to be got wrong and least likely to be
 * noticed.
 *
 * Run:  npx tsx scripts/feed-alarm-check.ts
 */
import { alarmCopy } from "../lib/feed-alarm";

type Row = { retailer: string; days_behind: number; status: string };

const CASES: { name: string; rows: Row[]; expect: string | null }[] = [
  {
    // Today, 9 September. This is the one that must print nothing.
    name: "all three one day behind (today)",
    rows: [
      { retailer: "coles", days_behind: 1, status: "ok" },
      { retailer: "woolworths", days_behind: 1, status: "ok" },
      { retailer: "harris_farm", days_behind: 1, status: "ok" },
    ],
    expect: null,
  },
  {
    name: "nothing at all (query failed, returns [])",
    rows: [],
    expect: null,
  },
  {
    // The nights of 5, 6 and 7 September. sales_as_of stuck on 1 Sept while
    // the engine reported ok and re-planned the network from stale demand.
    name: "the go-live-week gap: everything 4 days behind",
    rows: [
      { retailer: "coles", days_behind: 4, status: "late" },
      { retailer: "woolworths", days_behind: 4, status: "late" },
      { retailer: "harris_farm", days_behind: 4, status: "late" },
    ],
    expect: "late",
  },
  {
    // 3 August. Coles died and stayed dead for three weeks under a green light.
    name: "Coles dead 22 days, the others fine",
    rows: [
      { retailer: "coles", days_behind: 22, status: "stopped" },
      { retailer: "woolworths", days_behind: 1, status: "ok" },
      { retailer: "harris_farm", days_behind: 2, status: "ok" },
    ],
    expect: "stopped",
  },
  {
    name: "one stopped, one late",
    rows: [
      { retailer: "coles", days_behind: 22, status: "stopped" },
      { retailer: "harris_farm", days_behind: 4, status: "late" },
    ],
    expect: "stopped",
  },
];

let fails = 0;
for (const c of CASES) {
  const got = alarmCopy(c.rows);
  const level = got?.level ?? null;
  const ok = level === c.expect;
  if (!ok) fails++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!got) {
    console.log("        (silent — no bar)\n");
    continue;
  }
  console.log(`        [${got.level}] ${got.title}`);
  console.log(`        ${got.detail}`);
  console.log(`        ${got.warning}\n`);
}

console.log(fails === 0 ? "All cases pass." : `${fails} case(s) FAILED.`);
process.exit(fails === 0 ? 0 : 1);
