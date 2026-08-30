-- =====================================================================
-- Migration 069: jb_engine_stale_nights() was counting runs, not nights.
--
-- ---------------------------------------------------------------------
-- MY OWN BUG, ONE MIGRATION OLD
-- ---------------------------------------------------------------------
-- 068 added jb_engine_stale_nights() and said, in the function comment and
-- the commit message both:
--
--   "1 = the last run had fresh input. 3+ = a feed has stopped. Six nights is
--    what 23-28 August looked like."
--
-- It returned 11.
--
-- Not because the feeds are worse than thought. Because the function counts
-- consecutive RUNS that share the newest sales_as_of, and a run is not a
-- night. The nightly cron fires once at 02:00, but a manual replan fires
-- whenever somebody presses the button, and there have been several on the
-- same day. Eleven runs, fewer nights.
--
-- This is exactly the fault I fixed three times elsewhere in this build in the
-- last two days: a figure computed one way and rendered under a different
-- description. The accuracy panel showed a 4-week delta labelled as the 8-week
-- window. The lost-sales page called 41 permanent overrides "fixes". Both were
-- the same shape, and I wrote the commit message that says so -- "a figure
-- computed once and rendered under two different descriptions is what lets a
-- page disagree with itself" -- and then shipped it myself the same evening.
--
-- ---------------------------------------------------------------------
-- WHY THE NAME IS THE THING TO KEEP, NOT THE NUMBER
-- ---------------------------------------------------------------------
-- The cheap fix is to rename it jb_engine_stale_runs() and let 11 stand. That
-- is wrong, because runs is not the quantity anyone wants. The question is
-- "how long has the engine been planning from the same sales", and the unit a
-- person thinks in for that is nights. Pressing replan twice on a Tuesday does
-- not make the feed twice as dead.
--
-- Worse, run-counting is gameable in the direction that hides the fault: if
-- nobody touches the app for a week the streak grows slowly, and if somebody
-- replans four times in an afternoon it spikes. The number would move for
-- reasons that have nothing to do with the feed.
--
-- So: keep the name, fix the body, count nights.
--
-- ---------------------------------------------------------------------
-- WHAT A NIGHT IS
-- ---------------------------------------------------------------------
-- One Sydney calendar date on which at least one successful run happened, and
-- the sales_as_of of the LAST run of that date -- because that is the plan
-- that stood when everyone went home. If a feed lands at 4pm and a manual
-- replan picks it up, that night is fresh, whatever the 02:00 run saw.
--
-- Sydney, not UTC. current_date on Supabase is UTC and does not roll over
-- until 10am Sydney, so a UTC-dated night would file the 02:00 cron run under
-- the previous day. Same trap as 066.
--
-- ---------------------------------------------------------------------
-- v_engine_staleness IS LEFT ALONE
-- ---------------------------------------------------------------------
-- It is per-run and its columns say so. It was never the thing that lied; it
-- is the evidence you read when the number surprises you, and it is how this
-- bug was caught. A new v_engine_nights sits beside it as the per-night roll-up
-- the function reads, so the number and the working are the same object.
--
-- Idempotent. Reads only.
-- =====================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- One row per night the engine successfully ran.
-- ---------------------------------------------------------------------
create or replace view v_engine_nights as
  with last_of_night as (
    select distinct on ((started_at at time zone 'Australia/Sydney')::date)
           (started_at at time zone 'Australia/Sydney')::date as night,
           started_at,
           sales_as_of,
           trigger,
           plan_rows,
           plan_units
      from engine_runs
     where status = 'ok' and sales_as_of is not null
     order by (started_at at time zone 'Australia/Sydney')::date desc,
              started_at desc
  ),
  counted as (
    select n.*,
           (select count(*)::int
              from engine_runs e
             where e.status = 'ok'
               and (e.started_at at time zone 'Australia/Sydney')::date = n.night
           ) as runs_that_night,
           lag(n.sales_as_of) over (order by n.night) as prev_night_as_of
      from last_of_night n
  )
  select night,
         started_at at time zone 'Australia/Sydney' as last_run_sydney,
         trigger        as last_trigger,
         runs_that_night,
         sales_as_of,
         prev_night_as_of,
         -- NULL on the first night on record: unknown, not "fresh". Zero would
         -- read as a stall that did not happen.
         case when prev_night_as_of is null then null
              else (sales_as_of > prev_night_as_of) end as input_advanced,
         ((now() at time zone 'Australia/Sydney')::date - sales_as_of) as as_of_age_days,
         plan_rows, plan_units
    from counted;

comment on view v_engine_nights is
  'One row per Sydney calendar date on which the engine ran successfully, carrying the sales_as_of of the LAST run of that date -- the plan that stood at the end of the night. input_advanced is NULL for the first night on record (unknown, not fresh). This is the working behind jb_engine_stale_nights().';

-- ---------------------------------------------------------------------
-- The streak, in the unit the name promises.
-- ---------------------------------------------------------------------
create or replace function jb_engine_stale_nights()
returns int
language sql
stable
as $fn$
  with ordered as (
    select night, sales_as_of,
           row_number() over (order by night desc) as n
      from v_engine_nights
  ),
  newest as (select sales_as_of from ordered where n = 1)
  -- Consecutive most-recent NIGHTS whose standing plan used the newest
  -- sales_as_of. Counting stops at the first night that used anything else.
  select coalesce((
    select count(*)::int
      from ordered o, newest w
     where o.sales_as_of = w.sales_as_of
       and o.n < coalesce((select min(n) from ordered o2, newest w2
                            where o2.sales_as_of <> w2.sales_as_of), 2147483647)
  ), 0);
$fn$;

comment on function jb_engine_stale_nights() is
  'Consecutive most-recent NIGHTS (Sydney calendar dates) on which the engine planned from the same sales_as_of. 1 = last night had fresh input. 3+ = a feed has stopped. Counts nights, not runs: a manual replan is not another night. The per-night working is v_engine_nights; the per-run detail is v_engine_staleness.';

\echo ''
\echo '=== the working: one row per night, newest first ==='
select night, last_trigger, runs_that_night, sales_as_of,
       coalesce(input_advanced::text, '(first night on record)') as input_advanced,
       as_of_age_days, plan_units
  from v_engine_nights
 order by night desc
 limit 14;

\echo ''
\echo '=== nights vs runs — what 068 reported, and what is true ==='
select jb_engine_stale_nights() as stale_nights,
       (select count(*)::int from (
          select sales_as_of, row_number() over (order by started_at desc) as n
            from engine_runs where status = 'ok' and sales_as_of is not null
        ) o where o.sales_as_of = (
          select sales_as_of from engine_runs
           where status = 'ok' and sales_as_of is not null
           order by started_at desc limit 1)
          and o.n < coalesce((select min(n) from (
                select sales_as_of, row_number() over (order by started_at desc) as n
                  from engine_runs where status = 'ok' and sales_as_of is not null
              ) o2 where o2.sales_as_of <> (
                select sales_as_of from engine_runs
                 where status = 'ok' and sales_as_of is not null
                 order by started_at desc limit 1)), 2147483647)
       ) as what_068_counted_runs,
       (select max(sales_as_of) from engine_runs where status = 'ok') as planning_from,
       (now() at time zone 'Australia/Sydney')::date as today;

\echo ''
\echo '=== cross-check: the feeds themselves ==='
select retailer, last_sale, days_behind, status from v_feed_health order by days_behind desc;
