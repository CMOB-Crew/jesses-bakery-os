-- =====================================================================
-- Migration 053: undo the damage 052 did to stores that had their OWN
-- delivery days.
--
-- 052 corrected the six wrong RUNS. That part is right and stays.
--
-- Then it did this, and this part is wrong:
--
--   update stores st set delivery_days = r.run_days
--     where st.default_run_id = r.id and not exists (
--       select 1 from store_run_overrides o where o.store_id = st.id);
--
-- I assumed a store's days should equal its run's days unless it had a row in
-- store_run_overrides. That assumption is false. store_run_overrides records
-- which RUN serves a store on a given day — Coles Maroubra being on four
-- different runs. It says nothing about a store that is simply delivered less
-- often than the run it sits on.
--
-- So 052 overwrote the per-store schedules of stores that were deliberately on
-- fewer days than their run. The list is not abstract:
--
--   KOSHERLICIOUS            fri  ->  every day
--   MT ZION                  fri  ->  every day
--   WOLPER JEWISH HOSPITAL   wed  ->  every day
--   ROCHIE'S CRECHE          mon  ->  every day
--   JOHN & TONY'S            fri  ->  every day
--   GANEINU PRESCHOOL        fri  ->  tue,thu,sat,sun
--   MASADA                   fri  ->  tue,thu,sat,sun
--   LITTLE GINGER CAFE       wed  ->  mon,wed,sat
--   BAGEL X BREW             mon,sat -> mon,wed,sat
--
-- A preschool, a creche, a hospital and a synagogue kitchen, all moved from one
-- delivery a week to seven. Left alone, the engine would have planned six
-- deliveries a week to each of them from tonight's 2am run.
--
-- It also filled in the seven invoice cafes that were deliberately BLANK —
-- AKM, Maia, Meat Emporium, Oasis, Omorfos, St Ives Greengrocer, Urban Fresh.
-- Blank meant "nobody has told us yet". Now it means "seven days a week",
-- which is worse than not knowing.
--
-- ---------------------------------------------------------------------
-- THE RULE THIS SHOULD HAVE USED
-- ---------------------------------------------------------------------
-- A store follows its run only if it was ALREADY following its run. If its
-- days differed from the run's days before 052, that difference was a
-- decision, and 052 had no business erasing it.
--
-- jb_store_days_backup_052 and jb_run_backup_052 hold both sides of that
-- comparison, so this is computable exactly rather than by eye.
--
-- COMPARED AS SETS, NOT ARRAYS. `'{sun,mon,tue}' is distinct from
-- '{mon,tue,sun}'` is TRUE in Postgres — same days, different order, and array
-- comparison is positional. Several stores in 052's "moved" list only changed
-- order, which is why that list read 128 stores when the real number of
-- affected schedules is far smaller. Sorting both sides first is the
-- difference between fixing this and thrashing it.
--
-- Idempotent, and it restores from the snapshot rather than recomputing, so
-- running it twice does nothing the second time.
-- =====================================================================

\set ON_ERROR_STOP on

create or replace function jb_days_sorted(d weekday[]) returns text
  language sql immutable
  as $$ select coalesce(array_to_string(array(select unnest(d)::text order by 1), ','), '') $$;

comment on function jb_days_sorted(weekday[]) is
  'A weekday array as a sorted, comma-joined string, so two sets of days can be compared for CONTENT rather than array position. Postgres compares arrays positionally: {sun,mon} is distinct from {mon,sun}. That caught 052 out.';

\echo ''
\echo '=== what 053 is about to restore — stores that had their own schedule ==='
select b.name,
       jb_days_sorted(s.delivery_days)  as days_052_gave_them,
       jb_days_sorted(b.delivery_days)  as their_real_days,
       r.name                           as run,
       jb_days_sorted(rb.run_days)      as run_days_before_052
  from jb_store_days_backup_052 b
  join stores s   on s.id = b.store_id
  left join runs r on r.id = s.default_run_id
  left join jb_run_backup_052 rb on rb.run_id = s.default_run_id
 where jb_days_sorted(b.delivery_days) is distinct from jb_days_sorted(rb.run_days)
   and jb_days_sorted(b.delivery_days) is distinct from jb_days_sorted(s.delivery_days)
 order by cardinality(b.delivery_days), b.name;

-- Restore every store whose ORIGINAL days differed from its run's ORIGINAL
-- days. Those stores were never following the run, so the run being corrected
-- is not a reason to move them.
update stores s
   set delivery_days = b.delivery_days
  from jb_store_days_backup_052 b
  left join jb_run_backup_052 rb
    on rb.run_id = (select st.default_run_id from stores st where st.id = b.store_id)
 where s.id = b.store_id
   and jb_days_sorted(b.delivery_days) is distinct from jb_days_sorted(rb.run_days)
   and jb_days_sorted(b.delivery_days) is distinct from jb_days_sorted(s.delivery_days);

\echo ''
\echo '=== the seven that must be BLANK again — blank means nobody has told us ==='
select name, jb_days_sorted(delivery_days) as days
  from stores
 where name in ('AKM CAFE','MAIA CAFE','MEAT EMPORIUM ALEXANDRIA','OASIS OLYMPIC PARK',
                'OMORFOS CAFE BAR','ST IVES GREENGROCER','URBAN FRESH PUTNEY')
 order by name;

\echo ''
\echo '=== stores STILL differing from their backup (should be run-followers only) ==='
select b.name,
       jb_days_sorted(b.delivery_days) as was,
       jb_days_sorted(s.delivery_days) as now_is,
       r.name as run
  from jb_store_days_backup_052 b
  join stores s on s.id = b.store_id
  left join runs r on r.id = s.default_run_id
 where jb_days_sorted(b.delivery_days) is distinct from jb_days_sorted(s.delivery_days)
 order by r.name, b.name;

\echo ''
\echo '=== and the runs themselves are still corrected — 052 keeps that ==='
select name, array_to_string(run_days::text[], ',') as days,
       coalesce(nullif(array_to_string(run_pm::text[], ','), ''), '—') as evening
  from runs where cardinality(run_days) > 0 order by name;

\echo ''
\echo '=== the count that got me: blank stores ==='
select count(*) filter (where coalesce(cardinality(delivery_days),0) = 0) as no_days_should_be_7,
       count(*) as active
  from stores where active;
