#!/usr/bin/env node
//
// claude-md-agrees-with-the-code.mjs — READ ONLY. Changes nothing.
//
// CLAUDE.md IS THE FILE EVERY FUTURE AGENT READS FIRST. A FALSE LINE IN IT IS
// WORSE THAN A FALSE LINE ANYWHERE ELSE, BECAUSE IT IS BELIEVED BEFORE THE CODE
// IS READ.
//
// This build has now shipped four statements that asserted something the code
// did not do:
//
//   * the mail app's App RBAC scope, which existed in a comment and had never
//     been created in the tenant
//   * the driver licence photograph, which a comment said was filed and which
//     went to localStorage
//   * deliveries.driver_id, which referenced the wrong identity table
//   * CLAUDE.md line 39, which said the React Compiler was on when
//     next.config.ts has never had the key
//
// The first three were each found by accident, late, while looking for
// something else. This one was found by reading a 4,165-line audit branch four
// days after it was opened. None of them were found by anything that runs.
//
// So this runs.
//
// WHAT IT CHECKS
//
// One thing only, and on purpose: the claims in CLAUDE.md that can be settled
// by reading a file in this repository. Today that is the React Compiler,
// because it is the one CLAUDE.md states as a fact rather than a rule, and the
// one the performance audit contradicts.
//
// It compares the CLAIM against the CODE and fails when they disagree, in
// EITHER direction. It is not a check that the compiler is off. When card 2 of
// PERFORMANCE-FIXES.md turns it on, this script starts failing until the
// sentence in CLAUDE.md is corrected, which is precisely the point -- the two
// have to move together or one of them is lying again.
//
// WHY IT DOES NOT GREP FOR THE SENTENCE
//
// Four guards on this build have failed by matching their own explanation: a
// check for "week of ${" matched an error message, a check for "server-only"
// matched the comment saying why there was no server-only guard, a check for
// "redirect(" matched a comment about redirect(), and a check for
// "security definer" matched a comment describing the pattern. A guard that
// matches prose fails on its own prose.
//
// So this reads the STRUCTURE: which bullet, what it asserts, what the config
// actually says. The sentence can be rewritten freely as long as it stays true.
//
//   node scripts/claude-md-agrees-with-the-code.mjs
//
// Exit 0 if they agree, 1 if they do not. Run from the repo root.

import { readFileSync, existsSync } from "node:fs";

const fail = [];
const ok = [];

function must(path) {
  if (!existsSync(path)) {
    console.error(`FAIL  cannot find ${path}. Run this from the repo root.`);
    process.exit(1);
  }
  return readFileSync(path, "utf8");
}

const claudeMd = must("CLAUDE.md");
const nextConfig = must("apps/web/next.config.ts");
const pkg = must("apps/web/package.json");

// Comments are not configuration. A commented-out `reactCompiler: true` is
// exactly the shape that would make a prose grep say yes.
const stripTs = (s) =>
  s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

// ---------------------------------------------------------------------------
// What the code actually does.
// ---------------------------------------------------------------------------
const configCode = stripTs(nextConfig);
const keyOn = /\breactCompiler\s*:\s*true\b/.test(configCode);
const keyOff = /\breactCompiler\s*:\s*false\b/.test(configCode);
const pluginInstalled = /"babel-plugin-react-compiler"\s*:/.test(pkg);

// Next 16 can run the compiler without the Babel plugin, so the config key is
// what decides. The plugin is reported because its absence is the thing that
// makes a half-done switch-on silent on older setups.
const compilerOn = keyOn && !keyOff;

// ---------------------------------------------------------------------------
// What CLAUDE.md claims.
// ---------------------------------------------------------------------------
const bullets = claudeMd.split(/\r?\n/).filter((l) => /^\s*[-*]\s/.test(l));
const compilerBullets = bullets.filter((l) => /react\s+compiler/i.test(l));

if (compilerBullets.length === 0) {
  fail.push(
    "CLAUDE.md no longer says anything about the React Compiler. It said the " +
      "wrong thing once; saying nothing is not the fix, because the memo rules " +
      "below it only make sense against a stated answer."
  );
} else if (compilerBullets.length > 1) {
  fail.push(
    `CLAUDE.md states the React Compiler in ${compilerBullets.length} bullets. ` +
      "Two statements of one fact is how they drift apart. Keep one."
  );
} else {
  const bullet = compilerBullets[0];

  // "is not on" must be tested before "is on", and both are word-bounded so
  // that the negation cannot be read as the assertion.
  const claimsOff = /\bis\s+(?:not|never)\s+on\b/i.test(bullet);
  const claimsOn = !claimsOff && /\bis\s+on\b/i.test(bullet);

  if (!claimsOn && !claimsOff) {
    fail.push(
      "The React Compiler bullet in CLAUDE.md no longer says plainly whether " +
        "it is on. Say one or the other: an agent reading this has to know " +
        "whether the manual memo rules are load-bearing.\n        " +
        bullet.trim().slice(0, 140)
    );
  } else if (compilerOn && claimsOff) {
    fail.push(
      "next.config.ts sets reactCompiler: true, and CLAUDE.md says it is NOT " +
        "on. Correct the sentence."
    );
  } else if (!compilerOn && claimsOn) {
    fail.push(
      "CLAUDE.md says the React Compiler is on. next.config.ts has no " +
        "`reactCompiler: true`" +
        (pluginInstalled ? "" : " and babel-plugin-react-compiler is not installed") +
        ". This is the line the 10 September performance audit contradicts, " +
        "and it is the file every agent reads before the code."
    );
  } else {
    ok.push(
      `the React Compiler is ${compilerOn ? "on" : "off"}, and CLAUDE.md says so`
    );
  }

  // The rule survives the fact either way. With the compiler off it is the
  // only thing doing the work; with it on it is still how this repo writes
  // long lists. Deleting it along with the wrong sentence would be a
  // regression dressed as a correction.
  if (!/own component/i.test(bullet)) {
    fail.push(
      "the rule that rows of a long list live in their own component has gone " +
        "from the React Compiler bullet. The fact was wrong; the rule was not."
    );
  }
  if (!/useCallback/.test(bullet)) {
    fail.push(
      "the useCallback rule has gone from the React Compiler bullet. memo() " +
        "without stable handlers never bails out, so the two belong together."
    );
  }
}

// ---------------------------------------------------------------------------
for (const line of ok) console.log(`  ok    ${line}`);
if (fail.length === 0) {
  console.log("\nCLAUDE.md agrees with the code on everything checked here.");
  process.exit(0);
}
console.error("");
for (const f of fail) console.error(`  FAIL  ${f}`);
console.error(
  "\nCLAUDE.md governs every change in this repo. A false line in it is " +
    "believed before the code is read.\n"
);
process.exit(1);
