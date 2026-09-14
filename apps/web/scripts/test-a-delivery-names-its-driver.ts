/* A delivery names its driver and its run. Condition 12.
 *
 *   npx tsx scripts/test-a-delivery-names-its-driver.ts
 *
 * Condition 12 of the August decision record asks for "driver identity, store
 * and run validation, and duplicate detection per store per day".
 *
 * Duplicate detection was met by migration 080. The other two were not, and the
 * reason is worth keeping in front of whoever reads this next:
 * deliveries.driver_id referenced app_users, the legacy staff directory, while
 * the whole application uses public.users. The column was not forgotten, it was
 * unusable. Migration 098 repoints it.
 *
 * The rules live in SQL, so this cannot execute them without a database. What
 * it can do is hold the shape: that both write paths send a run, that the
 * server validates it rather than trusting the phone, that a second call for
 * the same stop cannot blank what the first one established, and that the
 * migration points at the right table. Every one of those is a line somebody
 * could quietly change while the app still appears to work.
 */
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const ACTIONS = read("../app/driver-proof-actions.ts");
const APP = read("../components/DriverApp.tsx");
const MIG = read("../../../db/migrations/098_condition_12_a_delivery_names_its_driver_and_its_run.sql");

let pass = 0;
const fails: string[] = [];
const ok = (label: string, cond: boolean, detail = "") => {
  if (cond) { pass++; return; }
  fails.push(label + (detail ? "\n      " + detail : ""));
};

// --- the migration points at the right identity system -----------------------
ok("the foreign key now references public.users",
   /foreign key \(driver_id\) references public\.users\(id\)/.test(MIG));
ok("and it is ON DELETE SET NULL, so removing a person cannot remove a delivery",
   /references public\.users\(id\) on delete set null/.test(MIG));
ok("the old app_users foreign key is dropped first",
   /drop constraint if exists deliveries_driver_id_fkey/.test(MIG));
ok("nothing in the migration writes to app_users",
   !/(insert|update|delete)[\s\S]{0,40}app_users/i.test(MIG.replace(/^--.*$/gm, "")));
ok("nothing is backfilled",
   !/^\s*update\s+deliveries/im.test(MIG.replace(/^--.*$/gm, "")));

// --- one upsert, not two ------------------------------------------------------
ok("there is a single upsert function", /async function upsertDelivery\(/.test(ACTIONS));
ok("and only one insert into deliveries in the whole file",
   (ACTIONS.match(/insert into deliveries/g) ?? []).length === 1,
   `found ${(ACTIONS.match(/insert into deliveries/g) ?? []).length}`);
ok("both write paths call it",
   (ACTIONS.match(/await upsertDelivery\(/g) ?? []).length === 2);

// --- the driver ---------------------------------------------------------------
ok("driver_id is in the insert column list",
   /insert into deliveries \([\s\S]{0,200}?driver_id, run_id, driver_sig_name\)/.test(ACTIONS));
ok("and it is filled from public.users, matched on the session email",
   /\(select u\.id from public\.users u\s*\n?\s*where lower\(u\.email\) = lower\(/.test(ACTIONS));
// app_users may be NAMED in a comment -- the migration and this change are
// about it, so forbidding the word would forbid explaining the fix. What must
// not survive is a line of code that reads or writes it.
ok("no line of code touches app_users",
   !/app_users/.test(
     ACTIONS.replace(/^\s*\/\/.*$/gm, "").replace(/^\s*--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")));

// --- the run, and the validation that makes it condition 12 -------------------
ok("run_id is validated against store_run_overrides for the weekday",
   /store_run_overrides o[\s\S]{0,200}?o\.day = lower\(to_char\(/.test(ACTIONS));
ok("and falls back to the store's default run",
   /coalesce\([\s\S]{0,400}?default_run_id/.test(ACTIONS));
ok("a run the store is not on is not written",
   /select r\.id from runs r[\s\S]{0,80}?where r\.id = /.test(ACTIONS));
ok("a non-uuid run id never reaches the database",
   /UUID\.test\(input\.runId\)/.test(ACTIONS));

// --- the second call for the same stop must not blank the first ---------------
ok("driver_id is coalesced on conflict, not overwritten",
   /driver_id\s*=\s*coalesce\(deliveries\.driver_id, excluded\.driver_id\)/.test(ACTIONS));
ok("run_id is coalesced on conflict, not overwritten",
   /run_id\s*=\s*coalesce\(deliveries\.run_id, excluded\.run_id\)/.test(ACTIONS));
ok("duplicate detection is still the (store, day) key from migration 080",
   /on conflict \(store_id, delivery_date\) do update/.test(ACTIONS));

// --- the phone actually sends it ----------------------------------------------
ok("saveDeliveryProof accepts a run", /saveDeliveryProof\(input: \{[\s\S]{0,220}?runId\?/.test(ACTIONS));
ok("recordDelivery accepts a run", /recordDelivery\(input: \{[\s\S]{0,220}?runId\?/.test(ACTIONS));
ok("the driver app sends it on the proof call",
   /saveDeliveryProof\(\{[\s\S]{0,400}?\n\s*runId,/.test(APP));
ok("the driver app sends it on the delivery call",
   /recordDelivery\(\{[\s\S]{0,200}?runId,/.test(APP));
// The subtle one. Without runId in the dependency list the callback keeps the
// run that was selected when it was created, which for a driver who switches
// run mid-shift is the wrong one -- and it would look completely correct.
ok("the proof callback depends on runId, so it cannot send a stale run",
   /\[dayIso, live, fix, runId\]/.test(APP));

// ---------------------------------------------------------------------------
if (fails.length) {
  console.error(`\n  ${fails.length} FAILED, ${pass} passed\n`);
  for (const f of fails) console.error("  " + f + "\n");
  process.exit(1);
}
console.log(`\n  ${pass} cases pass. A delivery now names its driver and its run.\n`);
