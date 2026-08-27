-- =====================================================================
-- Migration 051: the same fix as 050, applied to the view that is now the
-- slowest thing on the Overview.
--
-- 050 took v_store_week from 7,742ms to 1,049ms, measured on the live function
-- log. Total request went 12,950ms -> 9,244ms, which is under Netlify's 10,000
-- and therefore rendering — but 9.2 of a 10 second budget is not a fix, it is
-- a reprieve.
--
-- The log now says the slowest query is v_store_revenue_week at 5,450ms, and
-- it has BOTH of the problems this build has been chasing all day:
--
--   from sales_daily s, a
--   where s.sale_date >  a.as_of - interval '7 days'
--
--   * `a` is a CTE, so the lower bound never reaches the index (050's finding)
--   * `- interval '7 days'` yields a timestamp, which also stops it reaching
--     the index (046's finding)
--
-- One view, both traps, on the 1.15M-row table.
--
-- 050 already converted v_unit_revenue, which this view reads. This does
-- v_store_revenue_week itself.
--
-- Column list, order and types identical to 006. Idempotent.
-- =====================================================================

\set ON_ERROR_STOP on

create or replace view v_store_revenue_week as
  with rev as (
    select s.store_id,
           sum(s.invoice_cost)                                        as revenue_wk,
           round(sum(s.invoice_cost) / nullif(sum(s.units_sold),0),4) as avg_unit_revenue
    from sales_daily s
    where s.sale_date >  jb_asof() - 7
      and s.sale_date <= jb_asof()
      and s.invoice_cost is not null
    group by s.store_id
  ),
  waste_val as (
    select w.store_id,
           sum(w.qty * coalesce(ur.unit_revenue, 0))                  as waste_revenue_wk
    from wastage w
    left join v_unit_revenue ur
      on ur.store_id = w.store_id and ur.product_id = w.product_id
    where w.waste_date >  jb_asof() - 7
      and w.waste_date <= jb_asof()
    group by w.store_id
  )
  select r.store_id, r.revenue_wk, r.avg_unit_revenue,
         coalesce(wv.waste_revenue_wk, 0) as waste_revenue_wk
  from rev r
  left join waste_val wv on wv.store_id = r.store_id;

alter view v_store_revenue_week set (security_invoker = on);

comment on view v_store_revenue_week is
  'Per-store trailing-week revenue and revenue-weighted waste from Invoice_Cost — what the retailer pays Jesse, so REVENUE, not margin. Bounded with jb_asof() rather than a CTE column so both ends of the range reach the index; the CTE form left the lower bound as a row filter over 1.15M rows.';

-- Verify, as jbo_app with claims (NOT as postgres — it has BYPASSRLS), and
-- with select * (count(*) lets the planner prune the view and lies):
--   begin;
--   select set_config('request.jwt.claims',
--     json_build_object('sub',(select id from public.users where email='javonte@cmob.com.au'),
--                       'role','authenticated')::text, true);
--   set local role jbo_app;
--   explain (analyze, buffers, costs off) select * from v_store_revenue_week;
--   rollback;
