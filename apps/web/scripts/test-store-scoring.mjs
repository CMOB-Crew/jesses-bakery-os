/* Every branch of lib/store-scoring.ts, and the two invariants that matter:
 *
 *   1. Nothing delivered can NEVER read green.
 *   2. "Everything's on track today" can NEVER appear over zero measurements.
 *
 *   node scripts/test-store-scoring.mjs
 *
 * Imports the real module through tsx, so a change to the source is a change to
 * what is tested. See the npx line in ship-nothing-delivered-is-not-on-track.sh.
 */
import { scoreStore, isMeasured, isChaseable, scoreNote, SCORE_LABEL,
         overviewHeadline } from "../lib/store-scoring.ts";

let pass = 0;
const fails = [];
const is = (label, got, want) => {
  if (got === want) { pass++; return; }
  fails.push(`${label}\n      got:  ${JSON.stringify(got)}\n      want: ${JSON.stringify(want)}`);
};

const S = (o) => ({ retailer: "coles", has_sales_feed: true, sent: 100, sold: 80, status: "green", ...o });

// --- every branch, in order ------------------------------------------------
is("invoice wins outright",
   scoreStore(S({ retailer: "invoice", has_sales_feed: false, sent: 0, sold: 0 })), "invoice");
is("invoice wins even with a feed and deliveries",
   scoreStore(S({ retailer: "invoice", status: "red" })), "invoice");
is("no feed",        scoreStore(S({ has_sales_feed: false })), "no-feed");
is("no feed beats no delivery",
   scoreStore(S({ has_sales_feed: false, sent: 0 })), "no-feed");
is("nothing delivered", scoreStore(S({ sent: 0 })), "no-delivery");
is("negative sent is nothing delivered", scoreStore(S({ sent: -5 })), "no-delivery");
is("null sent is nothing delivered", scoreStore(S({ sent: null })), "no-delivery");
is("undefined sent is nothing delivered", scoreStore(S({ sent: undefined })), "no-delivery");
is("string sent still counts", scoreStore(S({ sent: "100", status: "amber" })), "amber");
is("measured red",   scoreStore(S({ status: "red" })), "red");
is("measured amber", scoreStore(S({ status: "amber" })), "amber");
is("measured green", scoreStore(S({ status: "green" })), "green");

// jb_status returning something unexpected must not become green by default --
// that is the exact shape of the bug this module exists for.
is("unknown status is not scored", scoreStore(S({ status: "nodata" })), "no-delivery");
is("null status is not scored",    scoreStore(S({ status: null })), "no-delivery");

// --- INVARIANT 1: nothing delivered is never green -------------------------
// The production case, spelled out. On 7 September all 201 stores the Overview
// called "On track" looked exactly like this: a live feed, real sales, no
// delivery record in the window, and jb_status handing back green off a NULL.
is("the production case: sales, no delivery, jb_status says green",
   scoreStore({ retailer: "coles", has_sales_feed: true, sent: 0, sold: 4200, status: "green" }),
   "no-delivery");

for (const sold of [0, 1, 4200]) {
  for (const status of ["red", "amber", "green", "nodata", null, undefined]) {
    for (const sent of [0, -1, null, undefined, "0"]) {
      const v = scoreStore({ retailer: "coles", has_sales_feed: true, sent, sold, status });
      is(`nothing delivered is never measured (sent=${JSON.stringify(sent)}, sold=${sold}, status=${status})`,
         isMeasured(v), false);
    }
  }
}

// --- isMeasured / isChaseable ----------------------------------------------
is("red is measured",    isMeasured("red"), true);
is("invoice is not measured", isMeasured("invoice"), false);
is("no-feed is not measured", isMeasured("no-feed"), false);
is("no-delivery is not measured", isMeasured("no-delivery"), false);
is("invoice is not chaseable", isChaseable("invoice"), false);
is("green is not chaseable",   isChaseable("green"), false);
is("no-feed is chaseable",     isChaseable("no-feed"), true);
is("no-delivery is chaseable", isChaseable("no-delivery"), true);

// --- labels and notes -------------------------------------------------------
for (const k of ["red", "amber", "green", "invoice", "no-feed", "no-delivery"]) {
  is(`${k} has a label`, typeof SCORE_LABEL[k] === "string" && SCORE_LABEL[k].length > 2, true);
}
// The two unscored states must not read the same, or the split was pointless.
is("no-feed and no-delivery read differently",
   SCORE_LABEL["no-feed"] === SCORE_LABEL["no-delivery"], false);
// "Awaiting feed" over a store whose feed is fine sends Simona to chase Coles
// for a file that already landed.
is("no-delivery does not say feed", /feed/i.test(SCORE_LABEL["no-delivery"]), false);

is("no-feed note points at the retailer", /chase the report/i.test(scoreNote("no-feed")), true);
is("no-delivery note points at our own record",
   /delivery record/i.test(scoreNote("no-delivery")), true);
is("no-delivery note says the feed is not the problem",
   /not the feed/i.test(scoreNote("no-delivery")), true);
is("green has no note", scoreNote("green"), null);
is("invoice has no note", scoreNote("invoice"), null);

// --- INVARIANT 2: never claim health without a measurement -----------------
const H = (red, amber, green, noFeed, noDelivery) =>
  overviewHeadline({ red, amber, green, noFeed, noDelivery });

// 7 September, after the fix. This is what the Overview will read.
is("the production case headline", H(0, 0, 0, 0, 201).line,
   "Nothing on this page has been measured today.");
is("the production case sub mentions both causes",
   /sales report or a delivery record/.test(H(0, 0, 0, 0, 201).sub), true);

for (const noFeed of [0, 10, 201]) {
  for (const noDelivery of [0, 10, 201]) {
    const h = H(0, 0, 0, noFeed, noDelivery);
    is(`no measurements never claims everything is on track (${noFeed}/${noDelivery})`,
       /on track/i.test(h.line), false);
    is(`no measurements never says the rest run themselves (${noFeed}/${noDelivery})`,
       /running themselves/i.test(h.sub ?? ""), false);
  }
}

// Red always leads, whatever else is true.
is("one red store", H(1, 0, 200, 0, 0).line, "1 store needs you today.");
is("many red stores", H(64, 30, 100, 0, 0).line, "64 stores need you today.");
is("red with a mostly-dark network still names the dark half",
   /cannot be measured/.test(H(2, 0, 1, 100, 100).sub), true);
is("red with a mostly-measured network says the rest run themselves",
   H(2, 0, 200, 1, 1).sub, "The rest are running themselves.");

// A genuinely healthy network keeps the old, correct sentence.
is("a healthy network still reads the same", H(0, 0, 201, 3, 3).line,
   "Everything's on track today.");
is("a healthy network sub is unchanged", H(0, 0, 201, 3, 3).sub,
   "The rest are running themselves.");

// Measured, but outnumbered: state the count rather than implying the network
// is fine. This is the shape the Overview will take in the first days of
// go-live, when only some runs have been packed and recorded.
is("outnumbered by unmeasured stores gives a count, not a reassurance",
   H(0, 0, 20, 100, 100).line, "20 stores are on track.");
is("outnumbered singular reads correctly", H(0, 0, 1, 5, 5).line, "1 store is on track.");
is("outnumbered names how many are unmeasured",
   /200 more cannot be measured/.test(H(0, 0, 20, 100, 100).sub), true);

// Amber alone must not read as "everything's on track" either. Five stores over
// Simona's watch threshold is not "everything on track", and the first version
// of overviewHeadline said exactly that because it only branched on red.
is("amber only is not everything on track",
   /Everything/.test(H(0, 5, 10, 0, 0).line), false);
is("amber only names the count", H(0, 5, 10, 0, 0).line, "5 stores to watch.");
is("one amber reads correctly", H(0, 1, 10, 0, 0).line, "1 store to watch.");
is("red outranks amber", H(3, 5, 10, 0, 0).line, "3 stores need you today.");

// No combination of counts may produce the reassuring sentence unless the
// network really is entirely green.
for (const red of [0, 1, 9]) {
  for (const amber of [0, 1, 9]) {
    for (const green of [0, 1, 99]) {
      for (const dark of [0, 1, 99]) {
        const h = H(red, amber, green, dark, dark);
        if (h.line === "Everything's on track today.") {
          is(`"everything on track" implies no red (${red}/${amber}/${green}/${dark})`, red, 0);
          is(`"everything on track" implies no amber (${red}/${amber}/${green}/${dark})`, amber, 0);
          is(`"everything on track" implies something was measured (${red}/${amber}/${green}/${dark})`,
             green > 0, true);
          is(`"everything on track" implies the measured half is the majority (${red}/${amber}/${green}/${dark})`,
             dark * 2 <= green, true);
        }
      }
    }
  }
}

// --- report -----------------------------------------------------------------
if (fails.length) {
  console.error(`\n  ${fails.length} FAILED, ${pass} passed:\n`);
  for (const f of fails) console.error("    " + f + "\n");
  process.exit(1);
}
console.log(`\n  ${pass} cases pass.\n`);
