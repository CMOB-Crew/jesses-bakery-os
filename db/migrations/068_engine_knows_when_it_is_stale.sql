-- =====================================================================
-- Migration 068: the engine should know when it is planning from old news.
--
-- ---------------------------------------------------------------------
-- FRED'S ASK, ALMOST WORD FOR WORD
-- ---------------------------------------------------------------------
-- 26 Aug, the one thing he wanted back from us:
--
--   "Alert when a feed stops. engine_runs.sales_as_of is the tell. Coles died
--    4 Aug and reported Success for three weeks. That's the difference between
--    our system and theirs."
--
-- We then did the same thing in a different shape. Every feed died on 22-23
-- August and the nightly engine reported ok, six nights running, planning from
-- the identical frozen week each time. Nothing anywhere said so.
--
-- 066 fixed the PAGE -- /feeds and the Overview now measure against the
-- calendar and say plainly that all three retailers have stopped. That works
-- for somebody who opens the app. Nobody opened it for six days.
--
-- ---------------------------------------------------------------------
-- WHAT THIS ADDS
-- ---------------------------------------------------------------------
-- The engine's own record of whether its input moved. Two things, both read
-- straight off engine_runs, no new writes on the hot path:
--
--   v_engine_staleness   per successful run: did sales_as_of advance since
--                        the previous successful run, and how many
--                        consecutive nights has it now been stuck?
--
--   jb_engine_stale_nights()  the current streak, as one integer, so the app
--                             and any future job can both ask the same
--                             question and get the same answer.
--
-- A run planning from the same day as the night before is not automatically
-- wrong -- a retailer reporting a day late does that once. A run that has
-- planned from the same day for THREE nights is a dead feed, and by six it is
-- what happened this week.
--
-- ---------------------------------------------------------------------
-- WHAT THIS DELIBERATELY IS NOT
-- ---------------------------------------------------------------------
-- It does not send anything. There is no email or Slack path out of this
-- database, and inventing one on the Saturday before go-live is how you get a
-- cron job that fails quietly -- which is precisely the failure being fixed.
--
-- This is the measurement. The delivery is a separate decision, and the honest
-- options are: surface it on the Overview where Simona already looks, or wire
-- a real notification once someone owns the address it goes to.
--
-- Idempotent. Reads only.
-- =====================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- Per successful run: did the input move?
-- ---------------------------------------------------------------------
create or replace view v_engine_staleness as
  with runs as (
    select id, started_at, sales_as_of, trigger, plan_rows, plan_units,
           lag(sales_as_of) over (order by started_at) as prev_as_of
      from engine_runs
     where status = 'ok' and sales_as_of is not null
  )
  select r.id,
         r.started_at at time zone 'Australia/Sydney' as started_sydney,
         r.trigger,
         r.sales_as_of,
         r.prev_as_of,
         -- NULL on the very first run: unknown, not "fresh". The difference
         -- matters, because zero would read as a stall that did not happen.
         case when r.prev_as_of is null then null
              else (r.sales_as_of > r.prev_as_of) end as input_advanced,
         (select (now() at time zone 'Australia/Sydney')::date - r.sales_as_of) as as_of_age_days,
         r.plan_rows, r.plan_units
    from runs r;

comment on view v_engine_staleness is
  'Per successful engine run, whether sales_as_of advanced since the previous successful run. input_advanced is NULL for the first run (unknown, not fresh). Fred asked for an alert when a feed stops and named sales_as_of as the tell; this is that signal, recorded rather than delivered.';

-- ---------------------------------------------------------------------
-- The current streak, as one number.
-- ---------------------------------------------------------------------
-- One function so the app, a future notifier and anyone at a psql prompt all
-- ask the same question. Two copies of a rule is how one of them goes stale --
-- which is the lesson this build keeps re-learning.
create or replace function jb_engine_stale_nights()
returns int
language sql
stable
as $fn$
  with ordered as (
    select sales_as_of,
           row_number() over (order by started_at desc) as n
      from engine_runs
     where status = 'ok' and sales_as_of is not null
  ),
  newest as (select sales_as_of from ordered where n = 1)
  -- How many of the most recent consecutive runs share the newest as-of date.
  -- 1 means the last run moved the input on. 6 means six nights on the same
  -- week of sales, which is what happened 23-28 August.
  select coalesce((
    select count(*)::int
      from ordered o, newest w
     where o.sales_as_of = w.sales_as_of
       and o.n <= coalesce((select min(n) from ordered o2, newest w2
                             where o2.sales_as_of <> w2.sales_as_of), 2147483647) - 1
  ), 0);
$fn$;

comment on function jb_engine_stale_nights() is
  'Consecutive most-recent successful engine runs that planned from the SAME sales_as_of. 1 = the last run had fresh input. 3+ = a feed has stopped. Six nights is what 23-28 August looked like while every run reported ok.';

\echo ''
\echo '=== the last 10 runs, and whether the input moved ==='
select started_sydney, trigger, sales_as_of, prev_as_of,
       coalesce(input_advanced::text, '(first run)') as input_advanced,
       as_of_age_days, plan_rows, plan_units
  from v_engine_staleness
 order by started_sydney desc
 limit 10;

\echo ''
\echo '=== THE NUMBER — consecutive nights planned from the same sales ==='
\echo '    1 means the last run had fresh input. 3 or more means a dead feed.'
select jb_engine_stale_nights()                        as stale_nights,
       (select max(sales_as_of) from engine_runs
         where status = 'ok')                          as planning_from,
       (now() at time zone 'Australia/Sydney')::date   as today,
       (now() at time zone 'Australia/Sydney')::date
         - (select max(sales_as_of) from engine_runs
             where status = 'ok')                      as sales_are_this_old;

\echo ''
\echo '=== cross-check against the feeds themselves ==='
select retailer, last_sale, days_behind, status from v_feed_health order by days_behind desc;
