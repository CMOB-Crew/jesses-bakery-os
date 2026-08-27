-- =====================================================================
-- Migration 062: the nightly engine plans from yesterday.
--
-- ---------------------------------------------------------------------
-- THE EVIDENCE
-- ---------------------------------------------------------------------
-- The first successful scheduled run, 02:00:00 Sydney on 28 Aug 2026, left a
-- plan covering 27 Aug to 2 Sept. It should have covered 28 Aug to 3 Sept.
--
-- jb_run_engine (033, line 465):
--
--     v_from date := current_date;
--     v_to   date := current_date + (greatest(p_days, 1) - 1);
--
-- current_date resolves in the session timezone, which is UTC on Supabase.
-- The cron fires at 16:00 UTC, which is always BEFORE UTC midnight, so
-- current_date is the day before the Sydney date the job is actually running
-- on. Every night. This is not a daylight-saving edge case:
--
--     16:00 UTC = 02:00 AEST (Apr-Oct)  = 03:00 AEDT (Oct-Apr)
--
-- Both land after Sydney midnight and before UTC midnight, so the off-by-one
-- is permanent in both halves of the year.
--
-- ---------------------------------------------------------------------
-- WHAT IT COSTS
-- ---------------------------------------------------------------------
-- 1. The seventh day is never planned. On the morning of 28 Aug the plan
--    reached 2 Sept, not 3 Sept — go-live day itself, unplanned until the
--    following night.
-- 2. One day of every run is spent planning yesterday.
-- 3. jb_rebuild_store_reco(v_from, v_to) folds that same shifted window into
--    store_reco, so the Deliveries board's weekly totals are built on a week
--    that starts yesterday.
--
-- Self-correcting, because the job runs nightly. But the forward visibility
-- is one day short of what the code intends, always.
--
-- ---------------------------------------------------------------------
-- THE FIX
-- ---------------------------------------------------------------------
-- Take the date in the timezone the bakery is in. Nothing else changes:
-- same procedure, same signature, same behaviour for a manual daytime call
-- (where UTC and Sydney already agree on the date most of the working day).
--
-- Patches the LIVE definition rather than retyping 100 lines of procedure,
-- for the same reason 057 did — two copies of the engine is how one of them
-- goes stale. Three guards: it must exist, must not already be patched, and
-- the anchor must appear EXACTLY TWICE (v_from and v_to). It refuses rather
-- than guessing.
-- =====================================================================

\set ON_ERROR_STOP on

\echo ''
\echo '=== BEFORE — the window the last scheduled run produced ==='
select trigger,
       started_at at time zone 'Australia/Sydney' as started_sydney,
       target_from, target_to,
       (target_from - (started_at at time zone 'Australia/Sydney')::date) as days_off
  from engine_runs where trigger = 'cron'
 order by started_at desc limit 3;

do $do$
declare
  src     text;
  patched text;
  n_hits  int;
  needle  constant text := 'current_date';
  replace_with constant text := '(now() at time zone ''Australia/Sydney'')::date';
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'jb_run_engine';

  if src is null then
    raise exception '062: jb_run_engine does not exist. Apply 033 first.';
  end if;

  if position('Australia/Sydney' in src) > 0 then
    raise notice '062: already applied — jb_run_engine already dates itself in Sydney.';
    return;
  end if;

  n_hits := (length(src) - length(replace(src, needle, ''))) / length(needle);
  if n_hits <> 2 then
    raise exception
      '062: expected current_date exactly twice in jb_run_engine (v_from and v_to), found %. Refusing to patch a procedure I do not recognise.', n_hits;
  end if;

  patched := replace(src, needle, replace_with);
  execute patched;
  raise notice '062: jb_run_engine now takes its date in Australia/Sydney.';
end
$do$;

\echo ''
\echo '=== PROOF: the live procedure reads the Sydney date ==='
select case when position('Australia/Sydney' in pg_get_functiondef(p.oid)) > 0
            then 'YES — dates itself in Sydney'
            else '*** NO — the patch did not take ***' end as verdict
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'jb_run_engine';

\echo ''
\echo '=== the two lines, so they can be read rather than trusted ==='
select trim(l) as date_lines
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral unnest(string_to_array(pg_get_functiondef(p.oid), E'\n')) as l
 where n.nspname = 'public' and p.proname = 'jb_run_engine'
   and (l like '%v_from%date%:=%' or l like '%v_to%date%:=%');

\echo ''
\echo '=== what UTC and Sydney think the date is right now ==='
select current_date                                    as utc_date,
       (now() at time zone 'Australia/Sydney')::date    as sydney_date,
       case when current_date = (now() at time zone 'Australia/Sydney')::date
            then 'same today — the difference only shows at the 2am run'
            else 'DIFFERENT right now' end             as note;

-- Undo: re-run 033, which redefines jb_run_engine using current_date.
