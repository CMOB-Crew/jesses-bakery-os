-- =====================================================================
-- Migration 046: v_store_week — put the ranging filter back, and stop
-- throwing away the index while we are in there.
--
-- ONE view, TWO defects, and it is the view that the Overview, Stores, every
-- store page, Benchmarks, Opportunities, Lost sales, Products, Launches and the
-- Map all read. Ten call sites in queries.ts.
--
-- ---------------------------------------------------------------------
-- DEFECT 1 — un-ranging a product does nothing. Confirmed on production.
-- ---------------------------------------------------------------------
-- Migration 021 taught this view to ignore products a store does not stock,
-- because Simona said it in Session 2 UAT on 21 Aug:
--
--     "stores look like underperformers because products NOT ranged to them
--      are still counted as sent but unsold."
--
-- Then 027 (has_sales_feed), 028 (stockout day counting) and 038 (a stockout
-- needs stock) each rebuilt this view from 002's body rather than 021's, and
-- each one silently dropped the filter. `create or replace view` does not warn
-- you that the body you are replacing had something yours does not.
--
-- Proven on production today:
--     select pg_get_viewdef('v_store_week') like '%store_product_ranging%'
--     -> false
--
-- And it is not theoretical. store_product_ranging holds 400 rows. Simona has
-- ranged four hundred store-product lines in and out, the toggle saves, the
-- store profile renders a dash — and not one of them moves a single number.
-- The profile even tells her "ranging set here shapes the plan."
--
-- ---------------------------------------------------------------------
-- DEFECT 2 — `date - interval` throws away the index, everywhere, seven times.
-- ---------------------------------------------------------------------
-- v_asof.as_of is a DATE. `as_of - interval '7 days'` yields a TIMESTAMP, which
-- demotes an Index Cond to a row Filter over the whole table.
--
-- We already learned this on this build and measured it: 836ms -> 128ms, and
-- 1,150,920 buffer pages -> 4,920. getWeekdayShape, getFeedStatus and migration
-- 042 all carry long comments about the trap. The one view that everything
-- reads was never converted. sales_daily is at 1.15 million rows.
--
-- Tommy said "this system is so slow" twice on the 26 Aug screen share. The
-- prefetch fix explained the request COUNT. This is the best remaining
-- explanation for the request DURATION.
--
-- Every column involved is a DATE (sales_daily.sale_date, deliveries
-- .delivery_date, wastage.waste_date, on_hand_ledger.as_of_date — all checked
-- in 001_init), so `- 7` compares date to date and the boundary rows are
-- IDENTICAL to `- interval '7 days'`. This changes the plan, not the answer.
--
-- ---------------------------------------------------------------------
-- WHAT THIS DOES NOT DO, deliberately
-- ---------------------------------------------------------------------
-- The `feed` CTE stays unfiltered by ranging: a store reporting sales on a line
-- it is not ranged for is still a store whose feed is alive, and that flag is
-- about the feed, not the product mix.
--
-- The `stk` CTE also stays unfiltered. Arguably an un-ranged line hitting zero
-- is not a stockout — but 021 never filtered it (038's stk did not exist yet)
-- and this migration restores 021, it does not extend it. Changing stockout
-- counting would move jb_status and the Lost sales estimate, five days from
-- go-live, on a judgement call nobody has asked for. Noted, not done.
--
-- Column list, order and types are IDENTICAL to 038 — `create or replace view`
-- requires that. security_invoker re-asserted (013) because we recreate it.
-- Idempotent.
-- =====================================================================

\set ON_ERROR_STOP on

create or replace view v_store_week as
with a as (select as_of from v_asof),
-- Feed liveness. Not ranging-filtered, on purpose — see the header.
feed as (
  select distinct sd.store_id
  from sales_daily sd, a
  where sd.sale_date >  a.as_of - 7
    and sd.sale_date <= a.as_of
),
sold as (
  select s.store_id, sum(s.units_sold)::int total_sold
  from sales_daily s
  left join store_product_ranging r
    on r.store_id = s.store_id and r.product_id = s.product_id, a
  where s.sale_date >  a.as_of - 7
    and s.sale_date <= a.as_of
    and coalesce(r.ranged, true)
  group by s.store_id
),
sold_prev as (
  select s.store_id, sum(s.units_sold)::int total_sold_prev
  from sales_daily s
  left join store_product_ranging r
    on r.store_id = s.store_id and r.product_id = s.product_id, a
  where s.sale_date >  a.as_of - 14
    and s.sale_date <= a.as_of - 7
    and coalesce(r.ranged, true)
  group by s.store_id
),
sent as (
  select d.store_id, sum(di.qty_sent)::int total_sent
  from deliveries d
  join delivery_items di on di.delivery_id = d.id
  left join store_product_ranging r
    on r.store_id = d.store_id and r.product_id = di.product_id, a
  where d.delivery_date >  a.as_of - 7
    and d.delivery_date <= a.as_of
    and coalesce(r.ranged, true)
  group by d.store_id
),
waste as (
  select w.store_id, sum(w.qty)::int total_wasted
  from wastage w
  left join store_product_ranging r
    on r.store_id = w.store_id and r.product_id = w.product_id, a
  where w.waste_date >  a.as_of - 7
    and w.waste_date <= a.as_of
    and coalesce(r.ranged, true)
  group by w.store_id
),
stk as (
  -- 038's body, unchanged apart from the date arithmetic. A stockout DAY is a
  -- calendar day on which a line hit zero with nothing left to expire AND
  -- there was stock there to run out of.
  select l.store_id,
         count(distinct l.as_of_date)
           filter (where l.closing_on_hand = 0
                     and l.expired = 0
                     and (l.opening_on_hand + l.delivered) > 0)::int stockout_days
  from on_hand_ledger l, a
  where l.as_of_date >  a.as_of - 7
    and l.as_of_date <= a.as_of
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
  coalesce(stk.stockout_days, 0)               as stockout_days,
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
  (f.store_id is not null)                     as has_sales_feed
from stores st
left join regions reg on reg.id = st.region_id
left join sold      on sold.store_id      = st.id
left join sold_prev on sold_prev.store_id = st.id
left join sent      on sent.store_id      = st.id
left join waste     on waste.store_id     = st.id
left join stk       on stk.store_id       = st.id
left join feed      f  on f.store_id      = st.id
where st.active;

-- 013: every v_* view runs as invoker or the base-table RLS policies never fire.
alter view v_store_week set (security_invoker = on);

comment on view v_store_week is
  'Per-store trailing week: sent, sold, wasted, stockout days, waste %, RAG status and whether the sales feed is alive. Ranging-aware (021, restored in 046 after 027/028/038 each dropped it). Integer date arithmetic throughout — `as_of - interval` yields a timestamp and silently costs the index on a 1.15M-row table.';

-- Verify:
--   -- the filter is back:
--   select pg_get_viewdef('v_store_week'::regclass) like '%store_product_ranging%' as ranging_on;
--   -- and no interval arithmetic survived:
--   select pg_get_viewdef('v_store_week'::regclass) like '%interval%' as still_has_interval;
--   -- what it cost the 400 ranging rows' stores (expect some to move):
--   select count(*) filter (where waste_pct is not null) as scored,
--          round(avg(waste_pct),1) as avg_waste from v_store_week;
