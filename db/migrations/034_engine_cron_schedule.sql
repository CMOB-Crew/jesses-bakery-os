-- 034 — schedule the nightly engine run
--
-- Split from 033 deliberately: 033 is pure schema and functions and applies
-- anywhere, including a local Postgres with no pg_cron. This file is the one
-- environment-specific step, and it is safe to skip if you are not on Supabase.
--
-- WHY pg_cron RATHER THAN A GITHUB ACTION OR A NETLIFY FUNCTION
--
-- The engine is entirely SQL. Running it from outside the database means
-- shipping a connection string to a runner, an extra network hop from wherever
-- that runner lives to Singapore, and a timeout budget to squeeze under.
-- pg_cron runs it where the data already is: no credential in transit, no
-- external dependency, no timeout. GitHub Actions cron was the other candidate
-- and it is routinely late by tens of minutes under load — survivable for the
-- keep-warm ping, not for the plan Simona reads at the start of the day.
--
-- TIMING. pg_cron reads the database timezone, which on Supabase is UTC.
-- 16:00 UTC is 02:00 in Sydney through winter and 03:00 once AEDT starts in
-- October. Both land well before the early shift, so the shift is not worth
-- engineering around.
--
-- ORDERING. The engine plans from sales_daily. When a nightly feed load is
-- eventually built it MUST land before this job, or the engine spends every
-- night recomputing the same plan from the same stale demand. Until then
-- engine_runs.sales_as_of is the tell: if that date stops moving, the feed has
-- stopped and the plan is fiction built on old sales.

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron is not installed — skipping the schedule.';
    raise notice 'On Supabase: Dashboard > Database > Extensions > enable pg_cron, then re-run this file.';
    raise notice 'Everything in 033 still works; the engine just has to be started by hand:  call jb_run_engine(7);';
    return;
  end if;

  -- Idempotent: drop any previous version of the job before scheduling.
  perform cron.unschedule('jb-nightly-engine')
    where exists (select 1 from cron.job where jobname = 'jb-nightly-engine');

  perform cron.schedule(
    'jb-nightly-engine',
    '0 16 * * *',
    $job$ call jb_run_engine(7, null, 'cron'); $job$
  );

  raise notice 'Scheduled jb-nightly-engine at 16:00 UTC (02:00 AEST / 03:00 AEDT).';
end
$$;

-- ------------------------------------------------------------------
-- Health view — so "is the engine still running?" is one query, and so the
-- app has something to put on the Settings page later.
-- ------------------------------------------------------------------
create or replace view v_engine_health as
select r.id                                              as last_run_id,
       r.status                                          as last_status,
       r.started_at                                      as last_started_at,
       r.finished_at                                     as last_finished_at,
       round(extract(epoch from (now() - r.started_at)) / 3600.0, 1) as hours_since_run,
       r.z,
       r.scenario,
       r.days_planned,
       r.plan_rows,
       r.plan_units,
       r.sales_as_of,
       (current_date - r.sales_as_of)                    as sales_age_days,
       r.error
from engine_runs r
order by r.id desc
limit 1;

alter view v_engine_health set (security_invoker = on);

comment on view v_engine_health is
  'The last engine run at a glance. sales_age_days is the one to watch: the plan can only be as current as the sales behind it, and a growing number there means the feed has stopped even though the engine is still running happily every night.';

-- Verify:
--   select * from cron.job where jobname = 'jb-nightly-engine';
--   select * from v_engine_health;
--   select jobid, runid, status, return_message, start_time
--     from cron.job_run_details order by start_time desc limit 5;
--
-- Run it by hand any time:      call jb_run_engine(7, null, 'manual');
-- Run it at a different level:  call jb_run_engine(7, 0.35, 'manual');
-- Stop the schedule:            select cron.unschedule('jb-nightly-engine');
