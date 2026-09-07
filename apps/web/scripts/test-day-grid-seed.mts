// Proves the one property option B has to have: seeding a line onto the day
// grid changes NOTHING about what is packed, except the day that was typed in.
//
// Calls the real setStoreDay() server action against a real Postgres holding
// the real schema, then reads back through the packing sheet's own query. Not a
// re-implementation of either side.
//
// Run against a throwaway database only. It writes.
import { q as sql } from "../lib/db";
import { setStoreDay } from "../app/store/actions";

const STORE = "11111111-1111-1111-1111-111111111111";
const DAYS = ["2026-09-08", "2026-09-09", "2026-09-11"]; // Tue, Wed, Fri

// The packing sheet's own SQL, lifted from getPackingRuns(), reduced to the
// columns this test asserts on.
async function packed(day: string): Promise<Record<string, number>> {
  const rows = await sql<{ name: string; qty: number; week_sent: number; src: string }[]>`
    with d as (select ${day}::date as day),
    wd as (select lower(to_char(day, 'Dy'))::weekday as w from d),
    byday as (
      select spd.store_id, spd.product_id, spd.qty::int as qty
        from store_product_days spd join wd on spd.dow = wd.w where spd.qty > 0),
    hasday as (select distinct store_id, product_id from store_product_days),
    planned as (
      select rp.store_id, rp.product_id, rp.recommended_qty::int as day_qty, o.qty::int as week_override
        from replenishment_plans rp join d on rp.target_date = d.day
        left join store_product_overrides o on o.store_id = rp.store_id and o.product_id = rp.product_id
         and (o.mode = 'perm' or o.ends_on is null or o.ends_on >= current_date)
       where coalesce(o.qty, rp.recommended_qty) > 0
         and not exists (select 1 from hasday h where h.store_id = rp.store_id and h.product_id = rp.product_id)),
    standing as (
      select sr.store_id, sr.product_id, sr.sent::int as week_sent from store_reco sr
       where sr.sent > 0
         and not exists (select 1 from replenishment_plans rp2, d where rp2.store_id = sr.store_id and rp2.target_date = d.day)
         and not exists (select 1 from hasday h where h.store_id = sr.store_id and h.product_id = sr.product_id)),
    merged as (
      select store_id, product_id, day_qty as qty, 0 as week_sent, 'plan' as src from planned where week_override is null
      union all select store_id, product_id, 0, week_override, 'planwk' from planned where week_override is not null
      union all select store_id, product_id, 0, week_sent, 'standing' from standing
      union all select store_id, product_id, qty, 0, 'day' from byday)
    select p.name, m.qty, m.week_sent, m.src
      from merged m join stores s on s.id = m.store_id and s.active
      join products p on p.id = m.product_id
     where (m.src in ('plan','planwk') or (select w from wd) = any(s.delivery_days))
       and s.id = ${STORE}::uuid`;

  // The app's own step: only 'plan' and 'day' are per-day numbers; everything
  // else is weekly and gets split. Imported, not rewritten.
  const { dayShare, dowMultipliers, dayIndexFromISO } = await import("../lib/dayshare");
  const { getWeekdayShape } = await import("../lib/queries");
  const mult = dowMultipliers(await getWeekdayShape());
  const idx = dayIndexFromISO(day);
  const out: Record<string, number> = {};
  for (const r of rows) {
    const qty = r.src === "plan" || r.src === "day"
      ? Number(r.qty)
      : dayShare(Number(r.week_sent), ["tue", "wed", "fri"], idx, mult);
    if (qty > 0) out[r.name] = qty;
  }
  return out;
}

async function snapshot() {
  const s: Record<string, Record<string, number>> = {};
  for (const d of DAYS) s[d] = await packed(d);
  return s;
}

function show(label: string, s: Record<string, Record<string, number>>) {
  console.log(`\n  ${label}`);
  for (const d of DAYS) {
    const line = Object.entries(s[d]).map(([k, v]) => `${k}=${v}`).join("  ") || "(nothing)";
    console.log(`    ${d}  ${line}`);
  }
}

let failures = 0;
function assert(ok: boolean, msg: string) {
  console.log(`    ${ok ? "ok  " : "FAIL"}  ${msg}`);
  if (!ok) failures++;
}

async function main() {
  await sql`delete from store_product_days`;

  const before = await snapshot();
  show("BEFORE — carried forward, no grid rows", before);

  // The action under test. Simona's case, exactly: "can you up Wednesday?"
  const res = await setStoreDay({
    storeId: STORE,
    productId: (await sql<{ id: string }[]>`select id::text from products where name = 'Bagel - Plain'`)[0].id,
    dow: "wed",
    qty: 12,
  });
  if (!("ok" in res) || !res.ok) throw new Error("setStoreDay failed: " + JSON.stringify(res));

  const after = await snapshot();
  show("AFTER — set Bagel - Plain to 12 on Wednesday", after);

  console.log("\n  assertions");
  assert(after["2026-09-09"]["Bagel - Plain"] === 12,
    "Wednesday is the number that was typed (12)");
  assert(after["2026-09-08"]["Bagel - Plain"] === before["2026-09-08"]["Bagel - Plain"],
    `Tuesday unchanged (${before["2026-09-08"]["Bagel - Plain"]}) — this is the bug B fixes`);
  assert(after["2026-09-11"]["Bagel - Plain"] === before["2026-09-11"]["Bagel - Plain"],
    `Friday unchanged (${before["2026-09-11"]["Bagel - Plain"]}) — this is the bug B fixes`);

  for (const d of DAYS) {
    for (const p of ["Bagel - Sesame", "Pita - White", "Sourdough - White"]) {
      assert(after[d][p] === before[d][p], `${p} untouched on ${d}`);
    }
  }

  // A zero must still cancel, and must not be refilled by the carry-forward.
  const sesame = (await sql<{ id: string }[]>`select id::text from products where name = 'Bagel - Sesame'`)[0].id;
  await setStoreDay({ storeId: STORE, productId: sesame, dow: "wed", qty: 0 });
  const cancelled = await snapshot();
  show("AFTER — Bagel - Sesame cancelled on Wednesday", cancelled);
  assert(cancelled["2026-09-09"]["Bagel - Sesame"] === undefined,
    "Wednesday really is off, not refilled by the carry-forward");
  assert(cancelled["2026-09-08"]["Bagel - Sesame"] === before["2026-09-08"]["Bagel - Sesame"],
    "cancelling Wednesday left Tuesday alone");

  // Seeding must happen once only. A second edit must not re-seed over a day
  // the user deliberately set to zero.
  await setStoreDay({ storeId: STORE, productId: sesame, dow: "fri", qty: 5 });
  const second = await snapshot();
  assert((await snapshot())["2026-09-09"]["Bagel - Sesame"] === undefined,
    "a later edit does not resurrect a day that was deliberately zeroed");
  assert(second["2026-09-11"]["Bagel - Sesame"] === 5, "the later edit itself took (Friday = 5)");

  console.log(failures === 0 ? "\n  all assertions pass.\n" : `\n  ${failures} FAILED\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
