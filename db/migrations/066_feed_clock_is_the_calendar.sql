-- =====================================================================
-- Migration 066: the feed-health clock cannot be made of the feed.
--
-- ---------------------------------------------------------------------
-- THE FAULT
-- ---------------------------------------------------------------------
-- v_feed_health measures every retailer against v_asof:
--
--     ((select as_of from a)::date - l.last_sale) as days_behind
--
-- and v_asof is `coalesce(max(as_of), current_date) from store_actuals` —
-- a number derived from the very data whose freshness is being judged.
--
-- So a feed is only ever "behind" relative to whichever feed is freshest.
-- Today that reads:
--
--     woolworths   0 days behind   "Today"   ok
--     harris_farm  0 days behind   "Today"   ok
--     coles       14 days behind             stopped
--
-- The real Sydney date is 28 August 2026. Measured against a calendar:
--
--     harris_farm  5 days   (last sale 23 Aug)
--     woolworths   6 days   (last sale 22 Aug)
--     coles       20 days   (last sale  8 Aug)
--
-- ALL THREE FEEDS ARE DEAD. The page says two of them are up to date.
--
-- ---------------------------------------------------------------------
-- WHY THIS IS STRUCTURAL, NOT AN OFF-BY-SIX
-- ---------------------------------------------------------------------
-- If every feed stops, v_asof stops with them. Every gap then computes to
-- zero and all three cards read "Today - Up to date" forever. The one page
-- whose entire job is to notice a dead feed goes blind at precisely the
-- moment it dies. It only appeared to work because Coles died while the
-- other two were still running, so the relative comparison had something
-- to compare against.
--
-- Which is the failure this page was built to prevent. From 039's own
-- comment: "Every row in Jesse's ETL log says Success — including the three
-- weeks Coles was writing nothing." Fred put it more precisely on 26 Aug:
-- "Coles died 4 Aug and reported Success for three weeks. That's the
-- difference between our system and theirs." We had rebuilt their bug in a
-- different shape.
--
-- ---------------------------------------------------------------------
-- WHY THE THRESHOLDS DO NOT CHANGE
-- ---------------------------------------------------------------------
-- Turning a relative clock into an absolute one makes healthy feeds look
-- late if they do not really arrive daily, so the cadence was measured
-- before this was written. Over the last 120 days of distinct sale dates:
--
--     woolworths   119 gaps, EVERY ONE exactly 1 day
--     harris_farm  120 gaps, every one exactly 1 day
--     coles         98 gaps, 96 of them 1 day (one 4, one 5)
--
-- These are daily feeds with no missed days at all. So <= 2 days = ok and
-- <= 5 = late were already the right numbers; they were just being applied
-- to the wrong clock. Nothing here re-tunes them.
--
-- ---------------------------------------------------------------------
-- WHAT ELSE THIS FIXES
-- ---------------------------------------------------------------------
-- The old upper bound `sale_date <= (select as_of from a)::date` also HID
-- newer sales. Harris Farm has 19 rows on 23 August that the page could not
-- see, because the bound came from a clock that had stopped on the 22nd. The
-- page reported Harris Farm's last sale as 22 Aug. It is 23 Aug.
--
-- ---------------------------------------------------------------------
-- WHAT IS PRESERVED, DELIBERATELY
-- ---------------------------------------------------------------------
-- 042's performance shape, exactly. Both ends of the range bounded, and
-- INTEGER date arithmetic — never `date - interval`, which yields a
-- timestamp and silently demotes the Index Cond to a row Filter, scanning
-- the table. 040 and 041 both got this wrong with the warning already
-- written down. The only change here is which date the arithmetic starts
-- from.
--
-- The 120-day bound keeps its stated cost: a retailer silent for more than
-- 120 days drops off rather than showing as very stale.
--
-- security_invoker is re-applied because create-or-replace is not a
-- guarantee it survives.
--
-- Idempotent, safe to re-run.
-- =====================================================================

\set ON_ERROR_STOP on

\echo ''
\echo '=== BEFORE — what the page is showing right now ==='
select retailer, last_sale, days_behind, status from v_feed_health order by days_behind desc;

create or replace view v_feed_health as
  with t as (
    -- The Sydney date, not current_date. current_date resolves in the session
    -- timezone, which is UTC on Supabase, and the UTC date does not roll over
    -- until 10am Sydney. The bakery works mornings. Same trap that filed 7am
    -- approvals under yesterday until migration 062.
    select (now() at time zone 'Australia/Sydney')::date as today
  ),
  last_seen as (
    select sd.source::text as retailer,
           max(sd.sale_date) as last_sale
      from sales_daily sd
     -- Both ends bounded, INTEGER arithmetic. See 042 — this is the
     -- difference between a Bitmap Index Scan and a million buffers.
     where sd.sale_date >  (select today from t) - 120
       and sd.sale_date <= (select today from t)
     group by 1
  )
  select l.retailer,
         l.last_sale,
         ((select today from t) - l.last_sale) as days_behind,
         case
           when ((select today from t) - l.last_sale) <= 2 then 'ok'
           when ((select today from t) - l.last_sale) <= 5 then 'late'
           else 'stopped'
         end as status,
         (select max(u.uploaded_at) from feed_uploads u
           where u.retailer::text = l.retailer and u.status = 'loaded') as last_upload
  from last_seen l;

alter view v_feed_health set (security_invoker = on);

comment on view v_feed_health is
  'Per-retailer freshness measured against the SYDNEY CALENDAR, not against v_asof. Anchoring to v_asof made the clock out of the same data being judged, so if every feed stopped, every gap computed to zero and all three read "up to date" forever — the exact silent failure this page exists to prevent. Thresholds unchanged (<=2 ok, <=5 late) because the feeds were measured as genuinely daily: 119 of 119 Woolworths gaps and 120 of 120 Harris Farm gaps are exactly one day. Bounded to 120 days with INTEGER date arithmetic; `date - interval` would yield a timestamp and silently undo the Index Cond.';

\echo ''
\echo '=== AFTER — measured against the Sydney calendar ==='
select retailer, last_sale, days_behind, status from v_feed_health order by days_behind desc;

\echo ''
\echo '=== THE CLOCKS, so the six-day gap is on the record ==='
select (now() at time zone 'Australia/Sydney')::date as sydney_today,
       (select as_of from v_asof)                    as v_asof,
       (now() at time zone 'Australia/Sydney')::date - (select as_of from v_asof) as asof_behind_by;

\echo ''
\echo '=== PLAN CHECK — want a Bitmap Index Scan, buffers in the thousands ==='
explain (analyze, buffers, costs off) select * from v_feed_health;
