-- =====================================================================
-- Migration 084: the run budget warning was a guess, and it was out by fifty
-- times.
--
-- ---------------------------------------------------------------------
-- WHAT IT SAYS TODAY
-- ---------------------------------------------------------------------
-- jb_check_run_budget() runs at the top of every engine run and warns whenever
-- statement_timeout is under FIVE MINUTES:
--
--     'a full seven-day run needs several minutes and will very likely be
--      cancelled'
--
-- 035 was right to put that check there. A run cancelled by the clock reports
-- as a broken query rather than an exhausted budget, and naming the problem up
-- front costs nothing. It was also right to make it a warning rather than an
-- exception.
--
-- The number was a guess. Nobody could have known better at the time, because
-- the engine did not measure itself: every run since the beginning logged 0
-- seconds, since finished_at used now(), which is frozen at the start of the
-- transaction that opens once the log row commits. Migration 083 fixed that
-- yesterday.
--
-- The first true measurement, on production, seven days, 9,154 rows:
--
--     7.00 seconds.
--
-- Not several minutes.
--
-- ---------------------------------------------------------------------
-- THIRTY SECONDS, AND WHY NOT SIXTY
-- ---------------------------------------------------------------------
--   * The measured run is 7 seconds, so 30 leaves four times headroom.
--   * Plan size tracks the number of stores with a live feed. It already
--     doubled, 4,470 -> 9,154 rows, when the feeds came back on 1 September,
--     and Simona is adding about thirty stores. 30 seconds still covers
--     several times the current size.
--   * The first draft of this migration used SIXTY, which reads sensibly until
--     you notice that anything calling the engine from a Netlify function has
--     to keep its own budget UNDER the 60-second function ceiling, or the
--     function is killed before the query is. A 60-second threshold would then
--     warn on every such run -- the crying-wolf problem this exists to fix,
--     reintroduced while fixing it. Caught by running the verification below,
--     not by reading it back.
--
-- The cron job keeps its 20-minute budget from 035. There is no reason to
-- tighten a nightly job nobody is waiting on.
--
-- ---------------------------------------------------------------------
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ---------------------------------------------------------------------
-- The first version of this migration also granted jbo_app EXECUTE on
-- jb_run_engine, so that a "rebuild the plan now" button in the app could call
-- it. Simona uploads the day's sales files, the plan on screen is still built
-- from last night's data, and the only way to refresh it is to wait for 2am or
-- find someone who can open psql. That is a real gap, most of all on go-live
-- morning.
--
-- The grant is not here, because it was never needed AND would not have been
-- enough. Postgres grants EXECUTE on a routine to PUBLIC by default, and
-- jb_run_engine still carries that default -- its ACL reads {=X/postgres,
-- postgres=X/postgres}, where the leading '=' is PUBLIC. So jbo_app could
-- already call it, and my grant would have been a no-op dressed up as a fix.
--
-- What actually happens was tested by running the engine as jbo_app rather than
-- reasoning about it, and it fails in layers:
--
--   0. EXECUTE is fine -- see above. That is why the first error is not a
--      permission error on the procedure itself.
--   1. permission denied for sequence engine_runs_id_seq
--   2. granted that, plus insert on engine_runs:
--      new row violates row-level security policy for table "engine_runs"
--   3. and behind that, every table the engine reads -- stores, products,
--      sales_daily, replenishment_plans, store_reco -- carries biz_all, which
--      compares current_app_role() against admin/manager/office. A route
--      calling this holds no user claims on that connection, so
--      current_app_role() is null and the whole plan reads zero rows. 033
--      raises an exception when a run plans nothing, so it would fail loudly
--      rather than silently, which is the one mercy.
--
-- The nightly cron is unaffected by any of this: it runs as postgres, which
-- bypasses RLS.
--
-- Three ways out, and only one of them is right:
--
--   a) Set the user's claims session-level on a reserved connection before the
--      call. Works, but session-level claims on a pooled connection are exactly
--      what lib/db.ts refuses to do -- one user's identity leaking into the next
--      request. Not worth breaking that rule for a convenience button.
--   b) Grant jbo_app write access to engine_runs, replenishment_plans and
--      store_reco and add null-claims policies. That punches a hole straight
--      through the flip everything else this week has been protecting.
--   c) The app INSERTS A REQUEST into a small queue table it is allowed to
--      write, and a pg_cron job a minute later picks it up and runs the engine
--      as postgres, exactly as the nightly job does. The UI polls engine_runs
--      for the new row. A minute of latency, no privilege change, no claims
--      games.
--
-- (c) is the design. It is not built here because it is a queue, a scheduled
-- job, a route and a screen, and shipping that at speed days before go-live is
-- how the last fortnight's bugs got written. rebuild-plan-now.sh in the build
-- folder covers the need until then.
--
-- Additive and idempotent. Replaces one function body, changes no data.
-- =====================================================================

begin;

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

  -- 30s, not the 300s migration 035 guessed. A measured seven-day run over
  -- 9,154 rows takes 7 seconds -- the first real timing, 4 September, once
  -- migration 083 made the duration a measurement rather than a frozen
  -- timestamp. Kept below 55s deliberately: see the note in this migration.
  if v_ms < 30000 then
    raise warning 'jb_run_engine: statement_timeout is % — a seven-day run measured 7 seconds over 9,154 rows, so this will probably still finish, but there is little headroom. For a manual run:  set statement_timeout = ''20min'';  first.',
      current_setting('statement_timeout');
  end if;
end
$fn$;

comment on function jb_check_run_budget() is
  'Warns when statement_timeout leaves little headroom for an engine run. Called at the top of jb_run_engine so the failure is named before it happens rather than surfacing as a cancelled query. Threshold 30s, set against a measured 7-second run over 9,154 rows (4 Sept, migration 083). Migration 035 guessed 5 minutes, which was out by about fifty times.';

commit;

-- ---------------------------------------------------------------------------
-- VERIFY. Run each line on its own and read the output, not just the row.
-- ---------------------------------------------------------------------------
--
-- 1. The old text is gone. Expect NO rows:
--
--   select proname from pg_proc
--    where proname = 'jb_check_run_budget'
--      and prosrc like '%needs several minutes%';
--
-- 2. Quiet where it should be, loud where it should be. The first two print no
--    WARNING at all; the third does:
--
--   set statement_timeout = '55s'; select jb_check_run_budget();
--   set statement_timeout = '30s'; select jb_check_run_budget();
--   set statement_timeout = '5s';  select jb_check_run_budget();
--   reset statement_timeout;
--
-- 3. Nothing was granted. has_function_privilege is the WRONG check here and
--    would mislead: it returns true for every role because PUBLIC holds EXECUTE
--    by default. Read the ACL instead and expect NO explicit jbo_app entry:
--
--   select proname, proacl from pg_proc
--    where proname = 'jb_run_engine' and pronamespace = 'public'::regnamespace;
--
--   -- expect {=X/postgres,postgres=X/postgres} -- the leading '=' is PUBLIC.
--   -- An added 'jbo_app=X/...' means the withdrawn first version was applied.
-- ---------------------------------------------------------------------------
