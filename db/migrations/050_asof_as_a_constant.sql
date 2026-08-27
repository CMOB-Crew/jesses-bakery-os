-- =====================================================================
-- Migration 050: the as_of bound comes from a CTE, so the planner cannot see
-- it, so every read of sales_daily scans 1.15 million rows and throws away
-- 1,150,412 of them.
--
-- This is the Overview's ten seconds, and it is not RLS.
--
-- ---------------------------------------------------------------------
-- THE EVIDENCE — explain (analyze) of `select * from v_store_week`, run as
-- jbo_app with real claims, RLS live:
-- ---------------------------------------------------------------------
--
--   Bitmap Heap Scan on sales_daily s   (actual time=357..2567 rows=5261)
--     Recheck Cond: (sale_date <= a.as_of)
--     Filter: (sale_date > (a.as_of - 7))
--     Rows Removed by Filter: 1150412
--
--   Seq Scan on sales_daily s_1         (actual time=0.2..973 rows=1155692)
--     Filter: ...
--     Rows Removed by Join Filter: 1150370
--
--   Index Only Scan ... sales_daily sd  (actual time=13..1451 rows=5261)
--     Index Cond: (sale_date <= a.as_of)
--     Filter: (sale_date > (a.as_of - 7))
--     Rows Removed by Filter: 1150412
--
--   Execution Time: 5509.395 ms
--
-- Three reads of sales_daily, ~5 seconds between them, every one of them
-- fetching the whole table and discarding 99.5% of it.
--
-- Look at what is an Index Cond and what is a Filter. The UPPER bound
-- (sale_date <= as_of) makes it into the index. The LOWER bound
-- (sale_date > as_of - 7) does not — it is applied afterwards, row by row,
-- across 1.15 million rows. So the index finds everything ever recorded and
-- then throws nearly all of it away.
--
-- WHY. `with a as (select as_of from v_asof)` is a CTE. Postgres scans it in a
-- nested loop and hands `a.as_of` down as a runtime value. It can parameterise
-- a bare column comparison into the index, but the expression `a.as_of - 7`
-- is not something it will push down, so that half becomes a filter.
--
-- This is NOT the `date - interval` trap 046 fixed. 046 was right and
-- necessary; this is a second, separate reason the same index was going
-- unused, hiding behind the first.
--
-- AND WHY NOBODY SAW IT. Every timing taken on this build today was run as
-- `postgres` through psql — which has BYPASSRLS, and, more to the point, was
-- run as `select count(*)`, which lets the planner prune most of the view
-- away. count(*) on v_store_week as jbo_app: 101ms. `select *`, which is what
-- the app actually runs: 5,509ms. Same view, same role, same moment.
--
-- ---------------------------------------------------------------------
-- THE FIX
-- ---------------------------------------------------------------------
-- Give the planner a constant instead of a CTE column. A STABLE function with
-- no arguments is evaluated once per statement and folded into the plan as a
-- parameter, which means BOTH bounds become index conditions and the scan
-- touches only the week we asked for.
--
-- jb_asof() wraps v_asof rather than reimplementing it, so whatever v_asof
-- means stays the single definition of "as of".
--
-- Column list, order and types identical to 046. Idempotent.
-- =====================================================================

\set ON_ERROR_STOP on

create or replace function jb_asof() returns date
  language sql
  stable
  as $$ select as_of from v_asof $$;

comment on function jb_asof() is
  'The as-of date as a STABLE scalar, so the planner folds it into a constant and both ends of a date range become index conditions. Reading it out of a CTE instead left the lower bound as a row filter, which made every sales_daily read scan 1.15M rows to return 5,261. Wraps v_asof so there is still one definition of "as of".';

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

alter view v_store_week set (security_invoker = on);

-- The revenue views carry the same CTE pattern and the same cost — 569ms as
-- jbo_app, second slowest on the page.
create or replace view v_unit_revenue as
  select
    s.store_id,
    s.product_id,
    sum(s.invoice_cost)                                          as revenue,
    sum(s.units_sold)::int                                       as units,
    round(sum(s.invoice_cost) / nullif(sum(s.units_sold), 0), 4) as unit_revenue
  from sales_daily s
  where s.sale_date >  jb_asof() - 7
    and s.sale_date <= jb_asof()
    and s.invoice_cost is not null
  group by s.store_id, s.product_id;

alter view v_unit_revenue set (security_invoker = on);

-- Verify (as jbo_app with claims, NOT as postgres, and with select * not count(*)):
--   begin;
--   select set_config('request.jwt.claims',
--     json_build_object('sub',(select id from public.users where email='javonte@cmob.com.au'),
--                       'role','authenticated')::text, true);
--   set local role jbo_app;
--   explain (analyze, buffers, costs off) select * from v_store_week;
--   rollback;
--
-- Every sales_daily node should now read "Index Cond" on BOTH ends and
-- "Rows Removed by Filter" should be in the hundreds, not 1,150,412.
