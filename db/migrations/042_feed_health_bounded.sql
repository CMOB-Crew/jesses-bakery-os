-- =====================================================================
-- Migration 042: use the shape that was already proven, and stop inventing.
--
-- 040 and 041 were both wrong, and the codebase already said so.
--
-- The plan from 041 is unambiguous:
--
--   Index Scan Backward using sales_daily_sale_date_idx   <- the DATE index
--     (actual time=141ms, loops=4)  Buffers: shared hit=1,057,291
--
-- It never used sales_daily_source_date_idx at all. With `order by sale_date
-- desc limit 1`, the planner sees a cheap start-up cost and walks the DATE
-- index backwards from the newest row, filtering on source, expecting to find a
-- match almost immediately. For Woolworths and Harris Farm it does. For Coles —
-- whose last sale is fourteen days back — it has to walk past every newer row
-- in the table first. Hence a million buffers to return one date.
--
-- MATERIALIZED (041) removed the repeated evaluation and was still right to do.
-- order-by-limit-1 (041) and the correlated max() (040) were both the wrong
-- shape, and getFeedStatus() in lib/queries.ts has carried a comment since
-- 25 Aug saying exactly that, from the last time this bit:
--
--   "Asking each retailer separately, which should be three index seeks,
--    measured WORSE — the correlated subquery doesn't get the plan the shape
--    suggests it should — and pushed the Overview past Netlify's 10s limit,
--    blanking the front page."
--
-- I rebuilt that mistake twice in an hour with the warning already written
-- down. So this view now uses the shape that has an EXPLAIN behind it: a
-- BOUNDED sale_date range, which is a Bitmap Index Scan with both ends in the
-- Index Cond.
--
-- The bound must be `date - integer`. NEVER `date - interval` — an interval
-- yields a TIMESTAMP, which silently demotes the Index Cond to a row Filter and
-- scans the table anyway. Same trap as getWeekdayShape.
--
-- WHAT THE BOUND COSTS US, stated rather than hidden: a retailer that has sent
-- nothing for more than 120 days drops off this view instead of showing as very
-- stale. The worst feed today is Coles at 14 days, and a four-month silence is a
-- different conversation from a stale badge. Same trade-off getFeedStatus()
-- already makes, so the two agree.
--
-- Idempotent, safe to re-run.
-- =====================================================================

create or replace view v_feed_health as
  with a as (select as_of from v_asof),
  last_seen as (
    select sd.source::text as retailer,
           max(sd.sale_date) as last_sale
      from sales_daily sd
     -- Integer date arithmetic, both ends bounded. This is the whole fix.
     where sd.sale_date >  (select as_of from a)::date - 120
       and sd.sale_date <= (select as_of from a)::date
     group by 1
  )
  select l.retailer,
         l.last_sale,
         ((select as_of from a)::date - l.last_sale) as days_behind,
         case
           when ((select as_of from a)::date - l.last_sale) <= 2 then 'ok'
           when ((select as_of from a)::date - l.last_sale) <= 5 then 'late'
           else 'stopped'
         end as status,
         (select max(u.uploaded_at) from feed_uploads u
           where u.retailer::text = l.retailer and u.status = 'loaded') as last_upload
  from last_seen l;

alter view v_feed_health set (security_invoker = on);

comment on view v_feed_health is
  'Per-retailer freshness against v_asof. status = stopped means that feed has died and every number for those stores is frozen. Bounded to 120 days with INTEGER date arithmetic — that bound is the difference between a Bitmap Index Scan and reading a million buffers, and `date - interval` would silently undo it by yielding a timestamp. A feed silent for more than 120 days drops off rather than showing as very stale; same trade-off getFeedStatus() makes, so the two agree.';

-- Verify:
--   \timing on
--   select * from v_feed_health order by days_behind desc;
--   explain (analyze, buffers, costs off) select * from v_feed_health;
--   -- want: Bitmap Index Scan with BOTH bounds in Index Cond, buffers in the thousands.
