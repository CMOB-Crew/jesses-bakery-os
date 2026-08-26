-- =====================================================================
-- Migration 041: finish the job 040 started.
--
-- 040 took v_feed_health from 1.06s to 0.72s. Better, not fixed, and the plan
-- says exactly why:
--
--     Subquery Scan on r
--       Filter: ((SubPlan 15) IS NOT NULL)
--       Buffers: shared hit=1101747
--
-- Two faults, both visible there.
--
-- 1. SubPlan *15*. The `last` CTE is inlined (Postgres 12+ does that by
--    default), so every reference to l.last_sale is substituted with the whole
--    correlated subquery and runs again. It is referenced five times — the
--    select, days_behind, twice inside the CASE, and once more in the WHERE —
--    which is why the planner numbered its way into the teens and why a filter
--    that should be free shows "Rows Removed by Filter: 1" as a cost. AS
--    MATERIALIZED computes it once. Same fix as the `stats` CTE in 037.
--
-- 2. 1.1M buffers is not an index lookup. max() SHOULD rewrite to an ordered
--    index scan taking one row, and evidently is not doing so reliably here.
--    Written as `order by sale_date desc limit 1` there is nothing to rewrite:
--    it is an Index Scan Backward that stops at the first row, by construction.
--
-- Same columns, same meaning, same output. Only the cost changes.
--
-- Idempotent, safe to re-run.
-- =====================================================================

create or replace view v_feed_health as
  with a as (select as_of from v_asof),
  r as (
    select unnest(enum_range(null::retailer_type)) as retailer
  ),
  -- MATERIALIZED on purpose. Without it this is computed once per reference to
  -- last_sale below, not once per retailer.
  last as materialized (
    select r.retailer,
           -- Not max(): order-by-limit-1 is the formulation the planner cannot
           -- turn into anything but an index scan backward stopping at row one.
           (select s.sale_date
              from sales_daily s
             where s.source = r.retailer
             order by s.sale_date desc
             limit 1) as last_sale
    from r
  ),
  -- Also materialized: the freshness arithmetic is done once here rather than
  -- repeated inside the CASE below.
  scored as materialized (
    select l.retailer,
           l.last_sale,
           ((select as_of from a)::date - l.last_sale) as days_behind
    from last l
    -- A retailer with no sales at all (invoice customers) has no freshness to
    -- report. Absent is the honest answer, not "infinitely behind".
    where l.last_sale is not null
  )
  select s.retailer::text as retailer,
         s.last_sale,
         s.days_behind,
         case
           when s.days_behind <= 2 then 'ok'
           when s.days_behind <= 5 then 'late'
           else 'stopped'
         end as status,
         (select max(u.uploaded_at) from feed_uploads u
           where u.retailer = s.retailer and u.status = 'loaded') as last_upload
  from scored s;

alter view v_feed_health set (security_invoker = on);

comment on view v_feed_health is
  'Per-retailer freshness, measured against v_asof — the same anchor every other figure uses. status = stopped means that feed has died and every number for those stores is frozen. Both CTEs are MATERIALIZED and the lookup is order-by-limit-1 rather than max(): inlined, this cost ~1s on 1.15M rows, which is enough to push a cold /feeds past Netlify''s 10-second budget and return an error page.';

-- Verify:
--   \timing on
--   select * from v_feed_health order by days_behind desc;
--   explain (analyze, buffers, costs off) select * from v_feed_health;
--   -- want: Index Scan Backward, loops = one per retailer, buffers in the hundreds.
