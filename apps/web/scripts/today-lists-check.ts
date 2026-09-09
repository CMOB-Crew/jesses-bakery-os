/**
 * today-lists-check.ts — the Overview's two lists, and what they say when
 * they are empty.
 *
 * The bug this guards against is not a crash. It is a page that empties
 * out and blames the wrong thing: on go-live morning, with all three
 * feeds current to the day before, the Overview said "Lights up as the
 * sales feed fills." The feed was full.
 *
 * Run:  npx tsx scripts/today-lists-check.ts
 */
import { listEmptyReason, hasLossToShow, type ListRow } from "../lib/today-lists";

const row = (p: Partial<ListRow>): ListRow => ({
  retailer: p.retailer ?? "coles",
  has_sales_feed: p.has_sales_feed ?? true,
  sent: p.sent ?? 0,
  sold: p.sold ?? 0,
  wasted: p.wasted ?? 0,
});

let fails = 0;
function check(name: string, cond: boolean, detail = "") {
  if (!cond) fails++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "\n        " + detail : ""}`);
}

console.log("— go-live morning: feeds full, nothing delivered —\n");

// 9 September, as production actually stood: sales current to 8 Sept for
// every scan store, and not one delivery record in the seven-day window.
const goLive = [
  row({ sold: 412 }),
  row({ retailer: "woolworths", sold: 233 }),
  row({ retailer: "harris_farm", sold: 96 }),
  row({ retailer: "invoice", has_sales_feed: false }),
];
const why = listEmptyReason(goLive, null);

check("names the delivery record, not the feed",
  /delivered/i.test(why.line) && !/sales feed fills/i.test(why.line), why.line);

check("says outright that the feed is not the problem",
  why.sub != null && /feed is not what is missing/i.test(why.sub), why.sub ?? "(no sub)");

check("counts the stores that ARE selling",
  why.line.includes("3 stores"), why.line);

check("does not send anyone to chase a retailer",
  !/chase/i.test(why.line + " " + (why.sub ?? "")), why.line);

console.log("\n— the other reasons, which go to other people —\n");

const noFeed = listEmptyReason([row({ has_sales_feed: false }), row({ has_sales_feed: false })], null);
check("a dead feed says chase the retailer",
  /chase/i.test(noFeed.sub ?? ""), noFeed.line);
check("a dead feed does not blame the delivery record",
  !/delivered/i.test(noFeed.line), noFeed.line);

const invoiceOnly = listEmptyReason(
  [row({ retailer: "invoice", has_sales_feed: false }), row({ retailer: "invoice", has_sales_feed: false })],
  null,
);
check("invoice customers are an absence, not a fault",
  /never scored/i.test(invoiceOnly.sub ?? ""), invoiceOnly.line);

const quiet = listEmptyReason([row({ sold: 0, sent: 0 })], null);
check("connected but quiet does not claim deliveries are missing",
  !/drivers/i.test(quiet.sub ?? ""), quiet.line);

const oneStore = listEmptyReason([row({ sold: 5 })], null);
check("one store reads as one store, not '1 stores'",
  oneStore.line.includes("1 store,") && oneStore.line.includes(" to it "), oneStore.line);

console.log("\n— a size filter names the size —\n");

const band = listEmptyReason([row({ retailer: "invoice", has_sales_feed: false })], "Small stores");
check("the empty message repeats the filter back",
  band.line.includes("Small stores"), band.line);

const bandMeasurable = listEmptyReason([row({ sent: 40, sold: 30, wasted: 10 })], "Large stores");
check("a thin cut is not reported as a missing delivery",
  !/delivered/i.test(bandMeasurable.line), bandMeasurable.line);

console.log("\n— biggest losses: no top ten of nothing —\n");

check("nothing delivered is not a loss", !hasLossToShow(row({ sold: 400 })));
check("delivered and all sold is not a loss", !hasLossToShow(row({ sent: 100, sold: 100 })));
check("delivered with waste is a loss", hasLossToShow(row({ sent: 100, sold: 60, wasted: 40 })));
check("the go-live network produces an empty losses list",
  goLive.filter(hasLossToShow).length === 0,
  "ten ranked stores at 0 units under a siren is a finding, not an absence");

console.log(fails === 0 ? "\nAll cases pass." : `\n${fails} case(s) FAILED.`);
process.exit(fails === 0 ? 0 : 1);
