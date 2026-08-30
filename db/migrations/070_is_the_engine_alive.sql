-- =====================================================================
-- Migration 070: a day counter that says 1 twelve hours after a good run,
--                and two views that drop good runs on a public holiday.
--
-- ---------------------------------------------------------------------
-- 1. A LIMIT ON THE STREAK, AND A CLAIM I GOT WRONG
-- ---------------------------------------------------------------------
-- jb_engine_stale_nights() counts consecutive NIGHTS THAT HAVE RUNS sharing
-- the same sales_as_of. A night with no run does not increment it. It is not a
-- zero, it is not a gap -- it simply is not in the set being counted. So if the
-- engine stops running altogether that number FREEZES and looks calm.
--
-- I concluded from this that nothing anywhere could see a dead engine, and
-- said so twice before checking. That was wrong. Migration 045 already built
-- jb_engine_health(), which takes
--
--     greatest(engine_runs last ok, cron.job_run_details last succeeded)
--
-- and answers exactly that question, including the cron-side failures that
-- never reach engine_runs at all. One grep of db/migrations would have found
-- it. The rule I keep writing into these files -- verify, do not reason --
-- applies to my own conclusions about what is missing, not only to bugs.
--
-- So the streak's limit is real but already covered. It stays as it is, and
-- this migration does not add a second function that answers the same
-- question, because two rules with one meaning is how one of them goes stale.
--
-- ---------------------------------------------------------------------
-- 2. A BUG I SHIPPED YESTERDAY IN 068 AND 069
-- ---------------------------------------------------------------------
-- jb_run_engine sets status like this:
--
--   status = case when v_empty > 0
--                 then 'ok (' || v_empty || ' empty days)'
--                 else 'ok' end
--
-- An empty day is legitimate and the procedure says so at length: nobody is
-- delivered that date, a public holiday or a shrunken run pattern will do it,
-- and aborting the week over one empty Wednesday would be worse.
--
-- Both my views filter `where status = 'ok'`. Exact match. So a perfectly
-- successful run that happened to include a public holiday is EXCLUDED from
-- the history, and reads as a night the engine never ran -- which, per section
-- 1, is the one thing the streak cannot see.
--
-- It has not bitten because Jesse currently delivers seven days a week, so
-- nothing has ever carried that status. The first public holiday after go-live
-- would have done it silently. Both views now use `status like 'ok%'`.
--
-- ---------------------------------------------------------------------
-- 3. THE FAILURES THE PROCEDURE CANNOT RECORD ABOUT ITSELF
-- ---------------------------------------------------------------------
-- Reading jb_run_engine, the boundary is exact:
--
--     jb_check_run_budget()  --+
--     insert into engine_runs  |  a failure HERE leaves no row at all
--     commit;                --+
--
--     begin ... exception    --   a failure HERE is recorded: status='failed',
--     end;                        error = sqlerrm, then re-raised
--
-- The design is deliberate and right -- the comment in the procedure explains
-- that the row is committed before any work precisely so a 2am failure leaves
-- a trace. But nothing can record a failure that happens before the recorder
-- exists. engine_runs row id 1 carries the evidence in its own error text:
-- "Cancelled by statement_timeout before the procedure could record its own
-- failure; closed out by migration 037." Hand-closed, once.
--
-- Two real ones this month, both in that blind zone: the 02:00 job failed on
-- 26 and 27 August with "invalid transaction termination" and engine_runs has
-- no row for either night. That specific cause is already fixed -- the old job
-- invoked the procedure in a context that wrapped it in a transaction, which
-- forbids COMMIT; the live job calls it directly and has run clean on 28, 29
-- and 30 August. But the blind zone is a property of the design, not of that
-- bug, and the next thing to fail in it will be just as quiet.
--
-- The only witness to those failures is cron.job_run_details. So the health
-- check reads it, which is why this function is security definer.
--
-- ---------------------------------------------------------------------
-- 4. DAYLIGHT SAVING, DELIBERATELY NOT CHANGED
-- ---------------------------------------------------------------------
-- The live schedule is '0 16 * * *', and pg_cron evaluates in UTC. 16:00 UTC
-- is 02:00 Sydney under AEST. Sydney moves to AEDT on Sunday 4 October 2026
-- and from that morning the same line fires at 03:00 Sydney.
--
-- Left alone on purpose. Three in the morning is still the middle of the
-- night, no delivery sheet is read before six, and changing the schedule of
-- the one unattended job four days before go-live buys a one-hour cosmetic
-- improvement for a real risk. Written down here so the next person finds a
-- decision rather than an oversight.
--
-- ---------------------------------------------------------------------
-- 5. WHAT NONE OF THIS FIXES
-- ---------------------------------------------------------------------
-- Nothing in apps/web calls any of it. Grepped: no match for
-- jb_engine_health, jb_engine_ or v_engine_ anywhere in the app. 045, 068,
-- 069 and now 070 are four migrations of instrumentation that no human being
-- can see. A correct number nobody reads has the same effect as no number.
--
-- That is the next commit, not this one, and it is the one that matters.
--
-- Idempotent. Recreates two views and replaces one function. No writes to any
-- table.
--
-- The two views are recreated exactly as they were on the security question --
-- no security_invoker clause, matching what 068 and 069 created -- because
-- changing how a view resolves permissions is not something to do blind while
-- also fixing two bugs in it. The last section prints what the setting
-- actually is, and whether engine_runs carries RLS at all, so that is a
-- decision made on evidence next rather than a guess made now.
-- =====================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- 069's view, with the status predicate corrected.
-- ---------------------------------------------------------------------
-- DROP then CREATE, not CREATE OR REPLACE. Replace can only APPEND columns to
-- a view; inserting last_status next to the other run columns, where it
-- belongs, is a rename as far as Postgres is concerned:
--
--   ERROR: cannot change name of view column "runs_that_night" to "last_status"
--
-- Safe to drop: nothing in the app selects from either of these views -- they
-- are one and two days old and were never wired to a page -- and
-- jb_engine_stale_nights() references v_engine_nights by name inside a quoted
-- SQL body, which Postgres does not dependency-track, so the drop does not
-- cascade into it. The function is recreated below regardless.
drop view if exists v_engine_nights;
create view v_engine_nights as
  with last_of_night as (
    select distinct on ((started_at at time zone 'Australia/Sydney')::date)
           (started_at at time zone 'Australia/Sydney')::date as night,
           started_at,
           sales_as_of,
           trigger,
           status,
           plan_rows,
           plan_units
      from engine_runs
     -- like 'ok%', not = 'ok'. A run that legitimately planned nothing on one
     -- day is recorded as 'ok (1 empty days)' and is still a successful run.
     where status like 'ok%' and sales_as_of is not null
     order by (started_at at time zone 'Australia/Sydney')::date desc,
              started_at desc
  ),
  counted as (
    select n.*,
           (select count(*)::int
              from engine_runs e
             where e.status like 'ok%'
               and (e.started_at at time zone 'Australia/Sydney')::date = n.night
           ) as runs_that_night,
           lag(n.sales_as_of) over (order by n.night) as prev_night_as_of
      from last_of_night n
  )
  select night,
         started_at at time zone 'Australia/Sydney' as last_run_sydney,
         trigger        as last_trigger,
         status         as last_status,
         runs_that_night,
         sales_as_of,
         prev_night_as_of,
         case when prev_night_as_of is null then null
              else (sales_as_of > prev_night_as_of) end as input_advanced,
         ((now() at time zone 'Australia/Sydney')::date - sales_as_of) as as_of_age_days,
         plan_rows, plan_units
    from counted;

comment on view v_engine_nights is
  'One row per Sydney calendar date on which the engine ran successfully, carrying the sales_as_of of the LAST run of that date -- the plan that stood at the end of the night. Success is status like ''ok%'', because a run with a legitimately empty day is recorded as ''ok (N empty days)''. input_advanced is NULL for the first night on record (unknown, not fresh).';

-- 068's per-run view, same predicate correction, same reason for the drop.
drop view if exists v_engine_staleness;
create view v_engine_staleness as
  with runs as (
    select id, started_at, sales_as_of, trigger, status, plan_rows, plan_units,
           lag(sales_as_of) over (order by started_at) as prev_as_of
      from engine_runs
     where status like 'ok%' and sales_as_of is not null
  )
  select r.id,
         r.started_at at time zone 'Australia/Sydney' as started_sydney,
         r.trigger,
         r.status,
         r.sales_as_of,
         r.prev_as_of,
         case when r.prev_as_of is null then null
              else (r.sales_as_of > r.prev_as_of) end as input_advanced,
         (select (now() at time zone 'Australia/Sydney')::date - r.sales_as_of) as as_of_age_days,
         r.plan_rows, r.plan_units
    from runs r;

comment on view v_engine_staleness is
  'Per successful engine run, whether sales_as_of advanced since the previous successful run. Success is status like ''ok%''. input_advanced is NULL for the first run (unknown, not fresh). The per-night roll-up is v_engine_nights.';

-- ---------------------------------------------------------------------
-- jb_engine_health(): ONE bug fixed, everything else left alone.
-- ---------------------------------------------------------------------
-- I wrote a whole new health function for this migration. It was already
-- built, in 045, and it is better than the one I wrote: it takes
--
--   greatest(engine_runs last ok, cron.job_run_details last succeeded)
--
-- which covers the blind zone described in section 3 above. My claim that
-- nothing anywhere could see a dead engine was simply wrong, and I made it
-- twice. Grepping db/migrations before writing would have cost one command.
--
-- The 26h / 36h thresholds on `status` are also right and are staying: the job
-- runs on a 24-hour cycle, so "more than 26 hours since a success" is a missed
-- night and "more than 36" is a stopped engine. That is a better instrument
-- than a day counter for that particular question.
--
-- ---------------------------------------------------------------------
-- THE ONE THING THAT IS WRONG
-- ---------------------------------------------------------------------
--   (extract(epoch from now() - last_ok) / 86400)::int  as days_since_success
--
-- That is rounded fractional days wearing a calendar label. Measured live at
-- 30 Aug, roughly midday Sydney, with the engine having run successfully at
-- 02:00 that same morning:
--
--   last_successful_run  2026-08-29 16:00 UTC  (= 02:00 Sydney, this morning)
--   days_since_success   1
--   status               ok
--
-- The engine ran twelve hours ago and the number says one day. It reads 0 all
-- morning and flips to 1 at lunchtime with nothing having changed. And because
-- ::int ROUNDS rather than truncates, a genuinely 34-hour-old success also
-- reads 1 -- one number covering "ran fine this morning" and "missed last
-- night".
--
-- Simona opens the app at 2pm on Thursday, reads "1 day since success", and
-- concludes the engine skipped a night. It didn't.
--
-- Calendar days in Sydney is what the label promises, so that is what it now
-- computes: 0 = ran today, 1 = last ran yesterday, 2+ = it has stopped. Same
-- correction as 066 made to v_feed_health and 069 made to the night counter --
-- measure against the calendar, because the calendar is what people read the
-- number as.
--
-- Signature is unchanged, deliberately: same six columns, same types, so this
-- is a create-or-replace and not a drop. Nothing in apps/web calls it today
-- (grepped -- no match for jb_engine_health, jb_engine_ or v_engine_ anywhere
-- in the app), but a drop would be a gratuitous risk for no gain.
--
-- Grants are left exactly as 045 set them. It revokes from public and then
-- grants execute back to public; tightening that to authenticated is a real
-- question but it is a separate one, and quietly changing who can call a
-- function while fixing arithmetic is how a permissions change ships without
-- anybody deciding it.
create or replace function jb_engine_health()
returns table (
  last_successful_run   timestamptz,
  last_attempt          timestamptz,
  last_attempt_status   text,
  last_attempt_message  text,
  days_since_success    int,
  status                text
)
language sql
security definer
set search_path = public, cron, pg_temp
as $function$
with ours as (
  select max(finished_at) filter (where status like 'ok%') as last_ok
    from engine_runs
),
theirs as (
  select max(start_time) filter (where status = 'succeeded') as last_ok,
         max(start_time)                                     as last_attempt,
         (array_agg(status order by start_time desc))[1]     as last_status,
         (array_agg(coalesce(return_message,'') order by start_time desc))[1] as last_message
    from cron.job_run_details d
    join cron.job j on j.jobid = d.jobid
   where j.jobname = 'jb-nightly-engine'
),
best as (
  select greatest(coalesce(ours.last_ok,   'epoch'::timestamptz),
                  coalesce(theirs.last_ok, 'epoch'::timestamptz)) as last_ok,
         theirs.last_attempt, theirs.last_status, theirs.last_message
    from ours, theirs
)
select
  last_ok                                     as last_successful_run,
  last_attempt                                as last_attempt,
  last_status                                 as last_attempt_status,
  left(last_message, 200)                     as last_attempt_message,
  -- CALENDAR days in Sydney, not rounded fractional days. 0 = ran today.
  -- The old form said 1 at lunchtime on a morning the engine ran perfectly.
  ((now() at time zone 'Australia/Sydney')::date
     - (last_ok at time zone 'Australia/Sydney')::date)::int as days_since_success,
  -- Unchanged from 045. Hours, not days, because the job is on a 24h cycle and
  -- "more than 26 hours since a success" is the precise statement of a missed
  -- night. A day counter cannot say that as well.
  case
    when last_ok < now() - interval '36 hours' then 'stopped'
    when last_ok < now() - interval '26 hours' then 'late'
    else 'ok'
  end                                         as status
from best;
$function$;

comment on function jb_engine_health() is
  'Is the nightly engine alive. Reads engine_runs AND cron.job_run_details and takes the later of the two, because a failure before jb_run_engine commits its own log row leaves no trace in engine_runs at all (hence security definer). From 045; migration 070 changed days_since_success from rounded fractional days to Sydney calendar days -- the old form read 1 at midday on a morning the engine had run fine at 02:00. status keeps the 26h/36h thresholds, which are the right instrument for a job on a 24-hour cycle.';

\echo ''
\echo '=== the correction: does any run carry an "ok (N empty days)" status? ==='
\echo '    None today -- Jesse delivers 7 days a week. The first public holiday'
\echo '    after go-live would have produced one, and 069 would have dropped it.'
select status, count(*) as runs
  from engine_runs
 group by status
 order by count(*) desc;

\echo ''
\echo '=== THE HEALTH CHECK — days_since_success should now read 0 ==='
\echo '    The engine ran at 02:00 Sydney this morning. Before this migration'
\echo '    this column said 1, because it rounded fractional days.'
select * from jb_engine_health();

\echo ''
\echo '=== the two numbers, and what each one is for ==='
select (select days_since_success from jb_engine_health()) as days_since_success,
       (select status from jb_engine_health())             as engine_status,
       jb_engine_stale_nights()                            as stale_nights,
       'engine alive (045, calendar-corrected here) vs input moving (069)' as what_they_measure;

\echo ''
\echo '=== how these views resolve permissions, and whether engine_runs has RLS ==='
\echo '    Recorded, not changed. 066 set security_invoker=on for v_feed_health;'
\echo '    if these differ that is a decision to make deliberately, not here.'
select c.relname                                              as object,
       coalesce((select option_value from pg_options_to_table(c.reloptions)
                  where option_name = 'security_invoker'), 'off (default)') as security_invoker,
       c.relrowsecurity                                       as rls_enabled
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('v_engine_nights','v_engine_staleness','v_feed_health','engine_runs')
 order by c.relname;

\echo ''
\echo '=== nights, newest first, now including any ok-with-empty-days run ==='
select night, last_trigger, last_status, runs_that_night, sales_as_of,
       coalesce(input_advanced::text, '(first night on record)') as input_advanced,
       as_of_age_days, plan_units
  from v_engine_nights
 order by night desc
 limit 10;
