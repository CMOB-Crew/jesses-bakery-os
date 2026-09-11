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
 * THE SECOND RULE, ADDED 10 SEPTEMBER, AND WHY THE FIRST ONE WAS NOT ENOUGH
 *
 * A sixth wrong date turned up, and this check could not see it -- not
 * because the rule was too loose but because the bug never went near a
 * formatter. StandingOrderPanel computed the Monday of the week being billed
 * like this:
 *
 *   const d = new Date(`${today}T00:00:00`);          // the BROWSER'S zone
 *   d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
 *   return d.toISOString().slice(0, 10);              // read back in UTC
 *
 * Two clocks in four lines. A bare "T00:00:00" has no zone, so it is midnight
 * on the viewer's laptop; toISOString() then reads that instant in UTC. In
 * Sydney that is the day before, so the invoice's period start was always the
 * SUNDAY, and it differed between two people drafting on different machines --
 * which is how the idempotency key that stops a customer being billed twice
 * came to depend on whose laptop it was.
 *
 * So: A FILE MAY NOT BOTH PARSE A DATE FROM TEXT WITH A ZONELESS "T00:00:00"
 * AND CALL toISOString(). Pick a clock and stay on it.
 *
 * Both halves are legitimate on their own and both are in use here. Parsing
 * "2026-09-07T00:00:00" as local midnight is the right way to show a reader
 * the day written in the data (FeedUpload, SeasonalityCalendar, StoreProfile).
 * toISOString() is the right way to record an instant (DriverApp stamping when
 * a stop was delivered). It is the pair that is a bug, every time, and the
 * pair is what this looks for.
 *
 * "T00:00:00Z" is not caught, correctly: the Z is a zone.
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

/* ------------------------------------------------------------------ *
 * RULE 2 — nothing parses on the local clock and reads back on UTC.
 *
 * Deliberately file-level and deliberately blunt. A scope-accurate version
 * would need to follow the Date through assignments, and the thing being
 * defended is not subtle: two clocks in one file, one of which is whatever
 * the viewer's laptop happens to be set to.
 *
 * Zoned literals ("...T00:00:00Z", "...T00:00:00+10:00") are not local
 * parses and are not counted.
 * ------------------------------------------------------------------ */
const LOCAL_PARSE = /T00:00:00(?!Z|[+-]\d)/;
const UTC_READ = ".toISOString()";

type Mixed = { file: string; parses: number[]; reads: number[]; exempt: boolean };
const mixed: Mixed[] = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const lines = readFileSync(file, "utf8").split("\n");

    // A line that is only a comment is describing the problem, not doing it.
    // This check's own explanation quotes the broken code, and so does
    // xero-invoice.ts -- a rule that forces you to delete the explanation in
    // order to go green is a rule that makes the codebase worse.
    const code = lines.map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? "" : l));

    const parses: number[] = [];
    const reads: number[] = [];
    code.forEach((l, i) => {
      if (LOCAL_PARSE.test(l)) parses.push(i + 1);
      if (l.includes(UTC_READ)) reads.push(i + 1);
    });
    if (!parses.length || !reads.length) continue;
    mixed.push({
      file, parses, reads,
      exempt: lines.some((l) => l.includes("tz-mix-ok:")),
    });
  }
}

const badMix = mixed.filter((m) => !m.exempt);

console.log(`\n${mixed.length} file(s) mix a local date parse with a UTC read.`);
for (const m of mixed.filter((x) => x.exempt)) {
  console.log(`PASS  exempt, marked tz-mix-ok  ${m.file}`);
}
for (const m of badMix) {
  console.log(
    `FAIL  two clocks in one file  ${m.file}\n` +
      `        parsed on the local clock at line(s) ${m.parses.join(", ")}\n` +
      `        read back as UTC at line(s) ${m.reads.join(", ")}`,
  );
}

if (bad.length || badMix.length) {
  if (bad.length) {
    console.log(
      `\n${bad.length} formatter(s) do not say which clock they are on.\n` +
        `Add timeZone: "Australia/Sydney", or a // tz-ok: comment above saying why not.`,
    );
  }
  if (badMix.length) {
    console.log(
      `\n${badMix.length} file(s) parse a date as local midnight and then read it back in UTC.\n` +
        `In Sydney that is the day before. Do the arithmetic in UTC (Date.UTC and\n` +
        `the setUTC*/getUTC* pair), or keep it local and never call toISOString().`,
    );
  }
  process.exit(1);
}
console.log("\nEvery date says which clock it is on, and no file is on two.");
