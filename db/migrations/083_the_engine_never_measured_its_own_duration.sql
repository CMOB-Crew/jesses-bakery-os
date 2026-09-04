-- =====================================================================
-- Migration 083: the engine has never measured how long it takes.
--
-- ---------------------------------------------------------------------
-- WHAT THE TABLE SAYS
-- ---------------------------------------------------------------------
-- The last ten runs, read on 4 September:
--
--   Fri 04 Sep 02:00  ok  cron  as_of 01 Sep   9,154 rows  35,629 units   0s
--   Thu 03 Sep 02:00  ok  cron  as_of 01 Sep   9,154 rows  35,336 units   0s
--   Wed 02 Sep 02:00  ok  cron  as_of 31 Aug   8,640 rows  34,175 units   0s
--   Tue 01 Sep 12:19  ok  manual-after-upload  8,640 rows  34,350 units   0s
--   Tue 01 Sep 02:00  ok  cron  as_of 23 Aug   4,470 rows  16,622 units   0s
--   Mon 31 Aug 02:00  ok  cron  as_of 23 Aug   4,470 rows  16,689 units   0s
--   Sun 30 Aug 02:00  ok  cron  as_of 23 Aug   4,470 rows  16,719 units   0s
--   Sat 29 Aug 02:00  ok  cron  as_of 23 Aug   4,470 rows  16,581 units   0s
--   Fri 28 Aug 11:46  ok  manual               4,470 rows  16,567 units   0s
--   Fri 28 Aug 09:52  ok  manual-tz-fix        4,473 rows  15,200 units   0s
--
-- Every night present, every one ok. That part is genuinely good news.
--
-- Zero seconds, ten times out of ten, for a job that plans nine thousand rows
-- across seven days and then folds the window into store_reco. That is not a
-- fast engine. It is a number that was never a measurement.
--
-- ---------------------------------------------------------------------
-- WHY IT IS ZERO
-- ---------------------------------------------------------------------
-- jb_run_engine is a PROCEDURE, deliberately, so it can commit its log row
-- before doing any work -- 033's comment explains that a 2am failure has to
-- leave a trace. The shape is:
--
--     insert into engine_runs (...)      -- started_at defaults to now()
--     commit;                            -- the row outlives the work
--     ... plan seven days ...            -- the actual work
--     update engine_runs set finished_at = now()
--
-- now() is transaction_timestamp(). After that COMMIT a new transaction opens
-- immediately, and its timestamp is fixed at that instant -- BEFORE the
-- planning loop runs. Every call to now() for the rest of the procedure returns
-- that same frozen value, so finished_at records the moment the work STARTED.
--
-- MEASURED, because this is the kind of claim that deserves a test rather than
-- an explanation. A procedure with the identical shape, and a two second sleep
-- standing in for the planning:
--
--     seconds via now() ................. 0.001
--     seconds via clock_timestamp() ..... 2.002
--
-- clock_timestamp() reads the actual wall clock at the moment it is called and
-- is not frozen by the transaction.
--
-- Then the real thing, not a stand-in: jb_run_engine itself, the same seven-day
-- window and the same four-row plan, run once with the procedure as it stands
-- today and once with this patch applied.
--
--     BEFORE-083 ..... 0.004 seconds
--     AFTER-083  ..... 0.047 seconds
--
-- Twelve times, on a plan of four rows. Production plans nine thousand and
-- reports 0 because the column is rounded to whole seconds -- so the real gap
-- there is not 0.04 of a second, it is however long the engine actually takes,
-- which nobody has ever seen.
--
-- ---------------------------------------------------------------------
-- WHY IT IS WORTH FIXING NOW
-- ---------------------------------------------------------------------
-- The plan just doubled. 4,470 rows a night while the feeds were stale, 9,154
-- once real sales landed on 1 September, and Simona is adding roughly thirty
-- stores. The engine already carries a run budget (035) and a liveness check
-- (070), and both exist because it has failed at 2am before -- twice, on 26 and
-- 27 August, before it could even write its log row.
--
-- A duration that always reads zero means nobody can see the engine getting
-- slower. There is no warning before it hits a timeout, only the timeout.
-- Migration 035 named the budget up front so a failure would not point
-- somewhere misleading; this is the other half of that -- knowing how much of
-- the budget is actually being used.
--
-- ---------------------------------------------------------------------
-- WHAT THIS CHANGES, AND WHAT IT DOES NOT
-- ---------------------------------------------------------------------
-- Two words, on both the success path and the failure path. Nothing about what
-- the engine plans, when it runs, or what it writes to replenishment_plans and
-- store_reco changes.
--
-- started_at is left alone. Its default is now() and that is correct: it is
-- evaluated in the transaction that inserts the row, before any work, which is
-- exactly when the run started.
--
-- Existing rows are not touched. Their finished_at is wrong and cannot be
-- recovered -- the information was never recorded. They keep reading ~0, and a
-- run from before this migration is identifiable by that.
--
-- Applied by self-patch through pg_get_functiondef, the same method as 057, 062,
-- 064 and 081. The pre-patch body is snapshotted to jb_fn_backup_083 first.
--
-- Additive and idempotent.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Snapshot before touching it.
-- ---------------------------------------------------------------------------
create table if not exists jb_fn_backup_083 (
  fn         text primary key,
  definition text not null,
  snapped_at timestamptz not null default now()
);

alter table jb_fn_backup_083 enable row level security;
alter table jb_fn_backup_083 force  row level security;
drop policy if exists biz_all on jb_fn_backup_083;
create policy biz_all on jb_fn_backup_083 for all
  using      ((select public.current_app_role()) = any (array['admin','manager','office']))
  with check ((select public.current_app_role()) = any (array['admin','manager','office']));

insert into jb_fn_backup_083 (fn, definition)
select 'jb_run_engine', pg_get_functiondef(p.oid)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where p.proname = 'jb_run_engine' and n.nspname = 'public'
on conflict (fn) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The patch. Two anchors, each required to appear exactly once.
-- ---------------------------------------------------------------------------
do $patch$
declare
  src text;
  ok_needle   constant text := 'set finished_at  = now(),';
  ok_fix      constant text := 'set finished_at  = clock_timestamp(),   -- 083: not now(); see the note in that migration';
  fail_needle constant text := 'set finished_at = now(), status = ''failed'', error = v_err';
  fail_fix    constant text := 'set finished_at = clock_timestamp(), status = ''failed'', error = v_err';
  n1 int; n2 int;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'jb_run_engine' and n.nspname = 'public';

  if src is null then
    raise exception '083: jb_run_engine does not exist. Nothing patched.';
  end if;

  if position('083: not now()' in src) > 0 then
    raise notice '083: already applied, leaving it alone.';
    return;
  end if;

  n1 := (length(src) - length(replace(src, ok_needle,   ''))) / length(ok_needle);
  n2 := (length(src) - length(replace(src, fail_needle, ''))) / length(fail_needle);

  if n1 <> 1 or n2 <> 1 then
    raise exception '083: anchors found % and % times, expected 1 and 1. Nothing patched. The live procedure is not in the state this migration was written against.', n1, n2;
  end if;

  execute replace(replace(src, ok_needle, ok_fix), fail_needle, fail_fix);
  raise notice '083: jb_run_engine patched -- the next run will record a real duration.';
end
$patch$;

commit;

-- ---------------------------------------------------------------------------
-- VERIFY.
-- ---------------------------------------------------------------------------
--
-- 1. Is the patch live?
--
--   select case when pg_get_functiondef(p.oid) like '%083: not now()%'
--               then 'YES - duration will be measured from the next run'
--               else 'NO  - PATCH DID NOT APPLY, STOP' end as patched
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where p.proname = 'jb_run_engine' and n.nspname = 'public';
--
-- 2. AFTER the next 2am run (or a manual `call jb_run_engine(7, null, 'manual');`),
--    the newest row should show a real number of seconds and every older row
--    should still show zero. One row per run:
--
--   select to_char(started_at at time zone 'Australia/Sydney','Dy DD Mon HH24:MI') as started_sydney,
--          status,
--          round(extract(epoch from (finished_at - started_at))::numeric, 2) as seconds,
--          plan_rows
--     from engine_runs
--    order by started_at desc
--    limit 5;
--
--   -- The zeros above the newest row are not a regression. That duration was
--   -- never recorded and cannot be recovered.
--
-- ---------------------------------------------------------------------------
-- UNDO:
--
--   do $undo$
--   declare d text;
--   begin
--     select definition into d from jb_fn_backup_083 where fn = 'jb_run_engine';
--     if d is null then raise exception 'no 083 backup found'; end if;
--     execute d;
--   end $undo$;
-- ---------------------------------------------------------------------------
