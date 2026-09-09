/**
 * dates-name-their-timezone-check.ts — every date this app renders says which
 * clock it is on.
 *
 * WHY THIS IS A TEST AND NOT A NOTE
 *
 * This is the fourth time in one week that a date has been wrong on a screen,
 * and it has been a different date each time:
 *
 *   5408efb  the app's clock was made of a table nothing writes
 *   a1215f6  the floor could not read the clock, so the app made one up
 *   d7c41d7  the heading said "Today" and meant the last seven days
 *   9335462  the headline number said "right now" and nothing recalculated it
 *
 * And then a fifth: the first automated mail pull ran at 2:01pm Sydney and
 * /feeds displayed it as "9 Sept, 4:01 am". The server runs in UTC, that
 * formatter did not name a zone, so it rendered UTC and looked local. Ten
 * hours out, on the one screen whose entire job is saying how fresh the
 * numbers are.
 *
 * Every one of those was found by a person noticing. This is the cheapest
 * thing that notices instead.
 *
 * THE RULE
 *
 * Any `new Intl.DateTimeFormat(...)` names an explicit `timeZone`.
 *
 * THE EXEMPTION, AND WHY IT EXISTS
 *
 * A browser component rendering a date with no time in it is the one honest
 * exception: parsed as local midnight, it shows the reader the day that is
 * written in the data, and naming a zone there would be pretending the value
 * carries a time it does not have. Mark those `// tz-ok:` with a reason on the
 * line above. The marker is deliberately ugly so it gets read.
 *
 * Run:  npx tsx scripts/dates-name-their-timezone-check.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["app", "components", "lib"];
const EXT = /\.(ts|tsx|mts)$/;
const CALL = "new Intl.DateTimeFormat(";

type Finding = { file: string; line: number; excerpt: string; exempt: boolean; zoned: boolean };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

const findings: Finding[] = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const src = readFileSync(file, "utf8");
    const lines = src.split("\n");
    let from = 0;
    for (;;) {
      const at = src.indexOf(CALL, from);
      if (at === -1) break;
      from = at + CALL.length;

      const line = src.slice(0, at).split("\n").length;

      // The options object ends where .format( begins. Looking past that would
      // read the NEXT formatter's options and call this one zoned.
      const rest = src.slice(at);
      const stop = rest.indexOf(".format(");
      const options = stop === -1 ? rest.slice(0, 400) : rest.slice(0, stop);

      // The marker sits somewhere in the comment block above the call. Eight
      // lines, because a real justification runs to a few sentences and the
      // call itself is often a line or two below the declaration it belongs
      // to. Three lines was not enough and the first exemption written slipped
      // straight past it.
      const above = lines.slice(Math.max(0, line - 9), line - 1).join("\n");

      findings.push({
        file,
        line,
        excerpt: (lines[line - 1] ?? "").trim().slice(0, 88),
        zoned: options.includes("timeZone"),
        exempt: above.includes("tz-ok:"),
      });
    }
  }
}

const bad = findings.filter((f) => !f.zoned && !f.exempt);
const exempt = findings.filter((f) => !f.zoned && f.exempt);
const zoned = findings.filter((f) => f.zoned);

console.log(`${findings.length} date formatter(s) found.\n`);
console.log(`PASS  ${zoned.length} name a timeZone`);
for (const f of exempt) {
  console.log(`PASS  exempt, marked tz-ok  ${f.file}:${f.line}`);
}
for (const f of bad) {
  console.log(`FAIL  no timeZone and no tz-ok marker  ${f.file}:${f.line}\n        ${f.excerpt}`);
}

if (bad.length) {
  console.log(
    `\n${bad.length} formatter(s) do not say which clock they are on.\n` +
      `Add timeZone: "Australia/Sydney", or a // tz-ok: comment above saying why not.`,
  );
  process.exit(1);
}
console.log("\nEvery date says which clock it is on.");
