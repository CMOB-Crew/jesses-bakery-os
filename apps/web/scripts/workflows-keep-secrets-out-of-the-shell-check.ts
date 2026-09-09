/**
 * workflows-keep-secrets-out-of-the-shell-check.ts — nothing templated is
 * pasted into a shell script, and the feed poll key never reaches a URL.
 *
 * TWO RULES, BOTH FROM REAL NEAR-MISSES.
 *
 * 1. GitHub expands its ${{ ... }} templates by TEXT SUBSTITUTION, before bash
 *    ever sees the script. A value carrying a quote or a semicolon stops being
 *    an argument and becomes part of the command. The safe shape is to put the
 *    value in `env:` and read it as an ordinary shell variable, which is what
 *    every workflow here already does.
 *
 *    This became worth testing on 9 September, when morning-feeds.yml gained a
 *    workflow_dispatch input for how far back to look. That is the first time a
 *    person-typed value came anywhere near a run block in this repository.
 *
 * 2. These run logs are PUBLIC — the repository is public and holds a client's
 *    production system. The feed poll secret travels in a request HEADER. A URL
 *    with ?key= in it would be printed in the log the first time anyone opened
 *    the run, and a published secret does not become unpublished.
 *
 * Run:  npx tsx scripts/workflows-keep-secrets-out-of-the-shell-check.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join("..", "..", ".github", "workflows");
const OPEN = "$" + "{{";

let fails = 0;
// The detail line is what went wrong, so it only prints when something did.
// A justification printed under a PASS reads like an instruction and trains
// people to skim the output.
function check(name: string, ok: boolean, detail = "") {
  if (!ok) fails++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && detail ? "\n        " + detail : ""));
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml")).sort();
console.log(files.length + " workflow(s): " + files.join(", ") + "\n");
check("there are workflows to check", files.length > 0, "no .yml files in " + DIR);

console.log("\n— rule 1: no template expansion inside a run block —\n");

for (const file of files) {
  const lines = readFileSync(join(DIR, file), "utf8").split("\n");
  const offences: string[] = [];
  let indent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (indent < 0) {
      // `run: |` or `- run: >`; the block is everything indented past it.
      const m = /^(\s*)-?\s*run:\s*[|>]/.exec(line);
      if (m) indent = m[1].length;
      continue;
    }
    const width = line.length - line.trimStart().length;
    if (line.trim() !== "" && width <= indent) {
      indent = -1;
      i--;                       // this line may itself open the next block
      continue;
    }
    if (line.includes(OPEN)) offences.push(file + ":" + (i + 1) + "  " + line.trim().slice(0, 80));
  }

  check(file + " reads templated values through env, not inline",
    offences.length === 0, offences.join("\n        "));
}

console.log("\n— rule 2: the feed poll key never appears in a URL —\n");

const POLL = "morning-feeds.yml";
if (!files.includes(POLL)) {
  check(POLL + " exists", false, "the scheduled feed pull is gone");
} else {
  const src = readFileSync(join(DIR, POLL), "utf8");

  check("the key is sent as a header",
    /-H\s+"x-feed-poll-key:/.test(src),
    "curl must carry the secret in x-feed-poll-key");

  const urls = src.match(/https:\/\/[^"'\s]+/g) ?? [];
  const leaking = urls.filter((u) => /[?&]key=/i.test(u));
  check("no URL in this workflow carries ?key=",
    leaking.length === 0, leaking.join("\n        "));

  check("hours is passed in the query string, where it belongs",
    /mail-poll\?hours=/.test(src),
    "the manual backfill needs ?hours= on the URL");

  check("the input is read from env and validated to digits",
    /HOURS_INPUT/.test(src) && /\*\[!0-9\]\*/.test(src),
    "a non-numeric input must fall back rather than reach curl");
}

console.log(fails === 0 ? "\nAll cases pass." : "\n" + fails + " case(s) FAILED.");
process.exit(fails === 0 ? 0 : 1);
