-- =====================================================================
-- Migration 045: the nightly engine has never once run successfully.
--
-- WHAT IS ACTUALLY HAPPENING
--
--   cron.job_run_details, every night since the schedule went in:
--
--     2026-08-26 16:00:00  failed  ERROR: invalid transaction termination
--     2026-08-25 16:00:00  failed  CONTEXT: jb_run_engine line 35 at COMMIT
--
--   43 milliseconds. It dies at the first COMMIT, before planning anything.
--
-- WHY
--
-- 033 made jb_run_engine a PROCEDURE on purpose, so it could COMMIT the
-- engine_runs row before doing any work — its own comment says why:
--
--     "if the planning below throws, an uncommitted log row would roll back
--      with it and a 2am failure would leave no trace anywhere except cron's
--      own history. The row has to outlive the work it describes."
--
-- That was right. Then 035 hit the 2-minute Supabase statement_timeout and
-- fixed it at the caller, because a mid-procedure SET cannot extend a timer
-- that is already armed. Also right. The schedule became:
--
--     set statement_timeout = '20min'; call jb_run_engine(7, null, 'cron');
--
-- Two statements in one pg_cron command are sent as a single simple-query
-- message, and Postgres wraps a multi-statement simple query in an IMPLICIT
-- TRANSACTION BLOCK. A procedure cannot COMMIT inside one. Hence "invalid
-- transaction termination".
--
-- So 035 fixed the timeout and broke the job, and the two migrations are each
-- individually correct.
--
-- THE PART THAT MADE IT INVISIBLE
--
-- The insert into engine_runs happens, then the COMMIT fails, so the insert
-- rolls back with it. There is NO engine_runs row for a failed night. The one
-- mechanism built to make a 2am failure visible is the exact mechanism that
-- fails. Everything downstream — the delivery sheet, the bake sheet, the
-- Overview — has been serving Monday's plan while looking perfectly healthy.
-- Which is, precisely, Coles reporting Success on 259,303 rows it never wrote.
--
-- THE FIX, in two parts
--
-- 1. Put the timeout where it is armed at SESSION start rather than statement
--    start: on the role pg_cron runs the job as, scoped to this database.
--    Read from cron.job rather than assumed, so this is correct whoever
--    scheduled it.
--
-- 2. Put the command back to a SINGLE statement, which is what 033 had and
--    what lets the procedure's COMMIT work.
--
-- The app connects as jbo_app and is untouched by part 1.
--
-- Idempotent. Safe to re-run. Plans nothing by itself — it repairs the
-- schedule; the next 2am run does the work.
-- =====================================================================

\set ON_ERROR_STOP on

do $$
declare
  v_user text;
  v_db   text := current_database();
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'pg_cron is not installed — 034 would have skipped silently. Stop and look.';
  end if;

  select username into v_user from cron.job where jobname = 'jb-nightly-engine';
  if v_user is null then
    raise exception 'jb-nightly-engine is not scheduled. Apply 034 first.';
  end if;

  -- PART 1. Armed when the session opens, so it covers the whole CALL
  -- including the seven jb_plan_day passes inside it.
  execute format('alter role %I in database %I set statement_timeout = %L',
                 v_user, v_db, '20min');
  raise notice 'statement_timeout 20min set on role % in database %', v_user, v_db;

  -- PART 2. One statement. No implicit transaction block, so COMMIT works.
  perform cron.unschedule('jb-nightly-engine');
  perform cron.schedule(
    'jb-nightly-engine',
    '0 16 * * *',                       -- 16:00 UTC = 2am Sydney (AEST, UTC+10)
    $job$call jb_run_engine(7, null, 'cron');$job$
  );
  raise notice 'jb-nightly-engine rescheduled as a single statement.';
end
$$;

-- ---------------------------------------------------------------------------
-- Make the NEXT silent failure impossible to miss.
--
-- Everything above repairs this specific break. This view answers the more
-- durable question — "when did the plan on screen last get rebuilt" — from
-- BOTH sides, so a night that leaves no engine_runs row still shows up.
--
-- Overview reads this the same way it reads feed health. A plan that has not
-- been rebuilt is exactly as dangerous as a feed that has stopped, and until
-- today we had an alert for one and nothing for the other.
-- ---------------------------------------------------------------------------
-- A SECURITY DEFINER function, not a plain view, and the reason matters:
-- migration 013 set every v_* view to security_invoker, and the app connects as
-- jbo_app, which has no rights on the cron schema. An invoker view over
-- cron.job_run_details would throw a permission error for the app — so the
-- alert built to stop silent failures would itself fail silently. Definer,
-- owned by the migration runner, with execute granted to the business roles.
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
as $fn$
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
)
select
  greatest(coalesce(ours.last_ok, 'epoch'::timestamptz),
           coalesce(theirs.last_ok, 'epoch'::timestamptz))       as last_successful_run,
  theirs.last_attempt                                            as last_attempt,
  theirs.last_status                                             as last_attempt_status,
  left(theirs.last_message, 200)                                 as last_attempt_message,
  (extract(epoch from now() - greatest(
      coalesce(ours.last_ok, 'epoch'::timestamptz),
      coalesce(theirs.last_ok, 'epoch'::timestamptz))) / 86400)::int as days_since_success,
  case
    when greatest(coalesce(ours.last_ok,'epoch'::timestamptz),
                  coalesce(theirs.last_ok,'epoch'::timestamptz)) < now() - interval '36 hours'
      then 'stopped'
    when greatest(coalesce(ours.last_ok,'epoch'::timestamptz),
                  coalesce(theirs.last_ok,'epoch'::timestamptz)) < now() - interval '26 hours'
      then 'late'
    else 'ok'
  end                                                            as status
from ours, theirs;
$fn$;

comment on function jb_engine_health() is
  'When the plan on screen was last rebuilt, read from engine_runs AND cron.job_run_details together. Both sources matter: a cron failure at the procedure''s first COMMIT rolls back its own engine_runs row, so our log shows nothing at all while cron shows the error. That is exactly the break 045 repairs, and it went unnoticed for two nights. 36-hour threshold = one missed night plus room for a late start. Same shape as feed health so the Overview can treat a dead engine like a dead feed.';

revoke all on function jb_engine_health() from public;
grant execute on function jb_engine_health() to public;

-- Verify:
--   select jobname, schedule, command from cron.job where jobname='jb-nightly-engine';
--   select rolname, rolconfig from pg_roles
--    where rolname = (select username from cron.job where jobname='jb-nightly-engine');
--   select * from jb_engine_health();
--   -- and to prove it rather than wait for 2am:
--   call jb_run_engine(7, null, 'manual');
