-- =====================================================================
-- Migration 040: make v_feed_health cheap enough for a cold page load.
--
-- WHAT HAPPENED
--
-- /feeds returned Chrome's "This page couldn't load" on the first hit after a
-- deploy, and rendered fine on the second. That is not a slow page, that is a
-- function that ran out of budget: Netlify allows 10 seconds, a cold start
-- costs most of it before a single query runs, and this page then asked for a
-- number that takes two more.
--
-- The expensive line was v_feed_health's:
--
--     select source, max(sale_date) from sales_daily group by 1
--
-- Unbounded, across 1.15M rows. Measured on production at 1.6-2.2 seconds even
-- with sales_daily_source_date_idx in place — a GroupAggregate still walks the
-- whole index to find four maximums.
--
-- THE FIX
--
-- Ask for the four maximums directly instead of grouping to discover them. One
-- correlated max() per retailer against (source, sale_date) is an index scan
-- backward that stops at the first row — four cheap lookups rather than one
-- long walk. The retailer list comes from the enum, so a new retailer appears
-- here automatically rather than being a hardcoded list to forget.
--
-- Same columns, same meaning, same output. Only the cost changes.
--
-- Additive, idempotent, safe to re-run.
-- =====================================================================

create or replace view v_feed_health as
  with a as (select as_of from v_asof),
  -- Every retailer the schema knows about, not just the ones with rows today —
  -- so a feed that has NEVER reported is visibly absent rather than silently
  -- missing from the list.
  r as (
    select unnest(enum_range(null::retailer_type)) as retailer
  ),
  last as (
    select r.retailer,
           -- Correlated max: Index Scan Backward using (source, sale_date),
           -- one row read per retailer. This is the whole point of the change.
           (select max(s.sale_date) from sales_daily s where s.source = r.retailer) as last_sale
    from r
  )
  select l.retailer::text                                   as retailer,
         l.last_sale,
         ((select as_of from a)::date - l.last_sale)        as days_behind,
         case
           when ((select as_of from a)::date - l.last_sale) <= 2 then 'ok'
           when ((select as_of from a)::date - l.last_sale) <= 5 then 'late'
           else 'stopped'
         end                                                as status,
         (select max(u.uploaded_at) from feed_uploads u
           where u.retailer = l.retailer and u.status = 'loaded') as last_upload
  from last l
  -- A retailer with no sales at all (invoice customers) has no freshness to
  -- report. Absent is the honest answer, not "infinitely behind".
  where l.last_sale is not null;

alter view v_feed_health set (security_invoker = on);

comment on view v_feed_health is
  'Per-retailer freshness, measured against v_asof — the same anchor every other figure uses. status = stopped means that feed has died and every number for those stores is frozen. Written as one correlated max() per retailer rather than a group-by: the group-by cost 1.6-2.2s on 1.15M rows, which was enough to push a cold /feeds past Netlify''s 10-second budget and return an error page.';

-- Verify (expect single-digit milliseconds, not seconds):
--   \timing on
--   select * from v_feed_health order by days_behind desc;
--   explain (analyze, buffers) select * from v_feed_health;
