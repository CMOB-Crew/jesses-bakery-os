-- 035 — give the nightly run a budget big enough to finish in
--
-- 033 landed on production and the first real run was cancelled 2 minutes in:
--
--   ERROR: canceling statement due to statement timeout
--   CONTEXT: PL/pgSQL function jb_plan_day(date,numeric) line 11
--            PL/pgSQL function jb_run_engine(integer,numeric,text) line 38
--
-- Nothing is slow. Supabase sets statement_timeout to 2 minutes, and the shape
-- of the work changed underneath that limit without anyone noticing:
--
--   BEFORE  27_replan_week.sh looped in bash and fired seven separate psql
--           statements. Each day got its own fresh 2-minute budget.
--   AFTER   jb_run_engine does all seven days inside one CALL. Seven days now
--           share ONE 2-minute budget.
--
-- Each day takes roughly 5-15s against the live data, so the total sits just
-- over the line. It worked on the local Postgres I tested against because that
-- fixture was three stores, and it has no such timeout anyway. A good reminder
-- that a green test on a small fixture says nothing about the limits the real
-- environment imposes.
--
-- WHY THE FIX HAS TO BE AT THE CALLER
--
-- statement_timeout is armed when the top-level statement begins. Changing the
-- GUC after that — inside the procedure, or via a function-level SET clause —
-- does not extend a timer that is already running. So the only thing that works
-- is setting it BEFORE the CALL, which means the cron command has to carry it.

do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron not installed — nothing to reschedule. Enable it, then run 034 followed by this file.';
    return;
  end if;

  perform cron.unschedule('jb-nightly-engine')
    where exists (select 1 from cron.job where jobname = 'jb-nightly-engine');

  perform cron.schedule(
    'jb-nightly-engine',
    '0 16 * * *',
    $job$ set statement_timeout = '20min'; call jb_run_engine(7, null, 'cron'); $job$
  );

  raise notice 'Rescheduled jb-nightly-engine with a 20 minute budget.';
end
$$;

-- ------------------------------------------------------------------
-- Fail fast and legibly when the budget is too small
-- ------------------------------------------------------------------
-- Without this, a caller who forgets the SET gets cancelled 2 minutes into a
-- run with a message pointing at line 11 of jb_plan_day — which reads like the
-- query is broken rather than like the clock ran out. A warning up front costs
-- nothing and names the actual problem before it happens.
--
-- Deliberately a warning and not an exception: on a small dataset the run may
-- genuinely finish inside 2 minutes, and refusing to start would be wrong.

create or replace function jb_check_run_budget()
returns void
language plpgsql
as $fn$
declare
  v_ms int;
begin
  -- statement_timeout comes back as text with a unit ('2min', '120s', '0').
  select case
           when current_setting('statement_timeout') in ('0', '') then 2147483647
           else extract(epoch from current_setting('statement_timeout')::interval)::int * 1000
         end
    into v_ms;

  if v_ms < 300000 then
    raise warning 'jb_run_engine: statement_timeout is % — a full seven-day run needs several minutes and will very likely be cancelled. Run  set statement_timeout = ''20min'';  first.',
      current_setting('statement_timeout');
  end if;
end
$fn$;

comment on function jb_check_run_budget() is
  'Warns when statement_timeout is too small for a full engine run. Called at the top of jb_run_engine so the failure is named before it happens rather than surfacing as a cancelled query two minutes later.';

-- Verify:
--   select command from cron.job where jobname = 'jb-nightly-engine';
--
-- Manual run — the SET must be its own statement, before the CALL, in the same
-- session. Separate -c flags share one psql session, so this works:
--   psql "$DATABASE_URL" -c "set statement_timeout='20min'" -c "call jb_run_engine(7, null, 'manual');"
