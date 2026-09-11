-- 093_nothing_ran_out_because_nothing_counted.sql
--
-- Every store profile in the system says "Nothing ran out this week."
--
-- It is the answer to the one question Simona asked for by name on 26 August --
-- "I've never, ever been able to see where we've sold out of stock" -- and the
-- system has not known it since 22 August.
--
-- Measured on production, 10 September:
--
--   on_hand_ledger rows                19,992
--   earliest as_of_date                2026-08-16
--   latest as_of_date                  2026-08-22
--   rows inside the 7-day window       0
--   jb_asof()                          2026-09-09
--   stores with stockout_days > 0      0
--   total stockout_days                0
--
-- The ledger is the legacy load and nothing has written it since. Nothing in
-- this repository writes it at all outside db/seed and the demo scripts. The
-- 24 August notes already recorded "on_hand_ledger empty, so the estimated
-- on-hand step does nothing" -- what nobody checked was what the SCREENS were
-- saying while it was empty.
--
-- THIS IS THE 26 AUGUST BUG AGAIN
--
-- That day's correction ends with a question to ask of any new metric: "what
-- does zero mean here, and can it mean two different things?" stockout_days
-- has meant two different things all along:
--
--   0 because the shelf never hit empty         -> "nothing ran out"
--   0 because nobody counted the shelf          -> "we do not know"
--
-- and v_store_week collapsed both into 0 with a coalesce. Every surface built
-- on top then reported the first meaning while the second was true: the store
-- profile's "Nothing ran out this week", its "Sold-out days: 0" tile, Lost
-- sales, the Opportunity Finder's capture-demand half, and the action list.
--
-- WHAT CHANGES HERE, AND WHAT DELIBERATELY DOES NOT
--
-- The distinction was already sitting in the view unused. The stk CTE groups
-- over the ledger inside the window, so a store with readings and no sellouts
-- gets a row holding 0, and a store with no readings gets NO ROW. That is
-- exactly the shape v_store_week already uses for the sales feed via
-- `f.store_id is null`. So:
--
--   stockout_days   coalesce(stk.stockout_days, 0)  ->  stk.stockout_days
--                   null now means "not counted", 0 means "counted, none"
--   has_on_hand     new. true when the ledger covers this store this week.
--
-- STATUS IS UNTOUCHED, ON PURPOSE. jb_status keeps taking
-- coalesce(stk.stockout_days, 0), so not one store changes colour. Worth being
-- explicit about why the null would have been harmless anyway:
--
--   case when waste_pct >= 20 or stockout_days >= 1 then 'amber' else 'green'
--
-- With a null second argument that arm is `false or null` = null, which a CASE
-- does not match, so the row falls to 'green' -- the same answer 0 gives today.
-- Identical either way. The coalesce stays regardless, because a traffic light
-- changing colour should be a decision someone made, not a side effect of a
-- column becoming nullable.
--
-- THIS DOES NOT FIX THE LEDGER, and it is not meant to. Writing it needs
-- on_hand(t) = on_hand(t-1) + delivered(t-1) - sold(t-1), and `delivered` only
-- began being captured yesterday in 25c926d -- there is nothing yet to compute
-- from. 037 also gates the engine's use of on-hand behind
-- app_settings.use_on_hand (still {"enabled": false}) because the ledger did
-- not reconcile: 23% of store-days held more than the shelf physically fits.
-- That decision stands. This migration only stops the screens claiming to know
-- an answer they do not have.
--
-- Everything else in the view is byte-for-byte 050.
-- Idempotent.

begin;

create or replace view v_store_week as
with feed as (
  select distinct sd.store_id
  from sales_daily sd
  where sd.sale_date >  jb_asof() - 7
    and sd.sale_date <= jb_asof()
),
sold as (
  select s.store_id, sum(s.units_sold)::int total_sold
  from sales_daily s
  left join store_product_ranging r
    on r.store_id = s.store_id and r.product_id = s.product_id
  where s.sale_date >  jb_asof() - 7
    and s.sale_date <= jb_asof()
    and coalesce(r.ranged, true)
  group by s.store_id
),
sold_prev as (
  select s.store_id, sum(s.units_sold)::int total_sold_prev
  from sales_daily s
  left join store_product_ranging r
    on r.store_id = s.store_id and r.product_id = s.product_id
  where s.sale_date >  jb_asof() - 14
    and s.sale_date <= jb_asof() - 7
    and coalesce(r.ranged, true)
  group by s.store_id
),
sent as (
  select d.store_id, sum(di.qty_sent)::int total_sent
  from deliveries d
  join delivery_items di on di.delivery_id = d.id
  left join store_product_ranging r
    on r.store_id = d.store_id and r.product_id = di.product_id
  where d.delivery_date >  jb_asof() - 7
    and d.delivery_date <= jb_asof()
    and coalesce(r.ranged, true)
  group by d.store_id
),
waste as (
  select w.store_id, sum(w.qty)::int total_wasted
  from wastage w
  left join store_product_ranging r
    on r.store_id = w.store_id and r.product_id = w.product_id
  where w.waste_date >  jb_asof() - 7
    and w.waste_date <= jb_asof()
    and coalesce(r.ranged, true)
  group by w.store_id
),
stk as (
  select l.store_id,
         count(distinct l.as_of_date)
           filter (where l.closing_on_hand = 0
                     and l.expired = 0
                     and (l.opening_on_hand + l.delivered) > 0)::int stockout_days
  from on_hand_ledger l
  where l.as_of_date >  jb_asof() - 7
    and l.as_of_date <= jb_asof()
  group by l.store_id
)
select
  st.id                                        as store_id,
  st.name,
  st.retailer,
  st.size_category,
  st.shelf_max,
  st.region_id,
  reg.name                                     as region,
  coalesce(sent.total_sent, 0)                 as total_sent,
  coalesce(sold.total_sold, 0)                 as total_sold,
  coalesce(sold_prev.total_sold_prev, 0)       as total_sold_prev,
  case when f.store_id is null then null else coalesce(
    waste.total_wasted,
    greatest(coalesce(sent.total_sent,0) - coalesce(sold.total_sold,0), 0)
  ) end                                        as total_wasted,
  -- NULL means the shelf was not counted. 0 means it was counted and never
  -- hit empty. They are not the same sentence, and the screens must not say
  -- the second one when the first is true.
  stk.stockout_days                            as stockout_days,
  case when f.store_id is null then null else round(
    100.0 * coalesce(
      waste.total_wasted,
      greatest(coalesce(sent.total_sent,0) - coalesce(sold.total_sold,0), 0)
    ) / nullif(coalesce(sent.total_sent,0), 0)
  , 1) end                                     as waste_pct,
  case when f.store_id is null then 'green' else jb_status(
    round(
      100.0 * coalesce(
        waste.total_wasted,
        greatest(coalesce(sent.total_sent,0) - coalesce(sold.total_sold,0), 0)
      ) / nullif(coalesce(sent.total_sent,0), 0)
    , 1),
    coalesce(stk.stockout_days, 0)
  ) end                                        as status,
  (f.store_id is not null)                     as has_sales_feed,
  (stk.store_id is not null)                   as has_on_hand
from stores st
left join regions reg on reg.id = st.region_id
left join sold      on sold.store_id      = st.id
left join sold_prev on sold_prev.store_id = st.id
left join sent      on sent.store_id      = st.id
left join waste     on waste.store_id     = st.id
left join stk       on stk.store_id       = st.id
left join feed      f  on f.store_id      = st.id
where st.active;

alter view v_store_week set (security_invoker = on);

comment on view v_store_week is
  'One row per active store for the trailing 7 days ending jb_asof(). Two columns carry a "we cannot see this" state and must not be read as zero: waste_pct/total_wasted are NULL where has_sales_feed is false, and stockout_days is NULL where has_on_hand is false (the on_hand_ledger has no reading for that store in the window). status deliberately still treats a null stockout_days as 0, so no store changes colour because a column became nullable. Migration 093, 10 September.';

commit;

-- Verify. On production as at 10 September the ledger stops at 22 August, so
-- expect every active store in the "not counted" column and none in the other
-- two:
--
--   select count(*) filter (where has_on_hand)                      as counted,
--          count(*) filter (where not has_on_hand)                  as not_counted,
--          count(*) filter (where has_on_hand and stockout_days > 0) as ran_out
--     from v_store_week;
--
-- And that nothing moved colour -- run this BEFORE and AFTER, expect the same
-- three numbers:
--
--   select status, count(*) from v_store_week group by status order by status;
