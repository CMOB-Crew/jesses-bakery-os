-- =====================================================================
-- Migration 054: revert 052's run-day change for Central Coast, City and
-- North West. The days it overwrote were right and the ones it wrote are not.
--
-- ---------------------------------------------------------------------
-- THE EVIDENCE
-- ---------------------------------------------------------------------
-- The deliveries table holds one week, 16-22 Aug 2026. Across that week,
-- comparing each store's scheduled days against the days a van actually
-- turned up:
--
--   Central Coast   scheduled sun,wed,fri   13 of 13 delivering stores got
--                                           mon, wed and sat. ZERO got fri.
--                                           ZERO got sun.
--   North West      scheduled sun,tue,thu,sat   17 stores on mon, 15 on wed,
--                                           17 on fri. ZERO on tue, thu, sun.
--   City            scheduled sun,tue,fri   15 stores on mon, 14 on wed.
--                                           ZERO on tue. ZERO on sun.
--
-- One week is thin evidence for one store. It is not thin evidence for a
-- whole run moving together, twice, on days that are unanimous.
--
-- And the clincher: the days those stores held BEFORE 052 are exactly the
-- days the vans went. From 052's own output:
--
--   COLES BATEAU BAY       mon,wed,sat      -> sun,wed,fri
--   COLES GLADESVILLE      mon,wed,fri,sat  -> sun,tue,thu,sat
--   COLES BROADWAY         fri,mon,wed      -> sun,tue,fri
--
-- The legacy data agreed with the delivery records. 052 replaced it with
-- Sahil's email and broke it.
--
-- ---------------------------------------------------------------------
-- WHY 052 WAS WRONG, as far as can be established
-- ---------------------------------------------------------------------
-- Sahil listed Central Coast as "Sunday pm, Wednesday am, Friday pm". Every
-- one of his evening days for these three runs lands one day before a day the
-- records show a delivery on. Sunday pm -> Monday. Friday pm -> Saturday.
-- Tuesday pm -> Wednesday. Thursday pm -> Friday.
--
-- The obvious reading is that he is describing when the van LEAVES and the
-- system records when the drop LANDS. That reading is NOT asserted here,
-- because it does not hold for the other two evening runs: Inner West's
-- Saturday pm and Western Sydney's Monday pm were both recorded on the day
-- itself, and both those runs match their schedule almost exactly.
--
-- So this migration does not act on the explanation. It acts on the
-- measurement: for these three runs the old days match the deliveries and the
-- new ones do not. Whatever the reason, the old days were right.
--
-- ---------------------------------------------------------------------
-- SCOPE — deliberately narrow
-- ---------------------------------------------------------------------
-- ONLY the three runs where every store moved together and the mismatch is
-- unanimous. South East and North Shore also disagree with their schedules,
-- but partially and in both directions, and one week cannot separate a wrong
-- day from a skipped delivery there. Those are left alone and go to Sahil as
-- a question.
--
-- run_pm is CLEARED for these three. It currently names days these runs do
-- not deliver on, which would put an "evening drop" mark on the Deliveries
-- board against a day no van goes. Keeping a wrong label is worse than
-- keeping none. Sahil's original text stays in 052's comment, so nothing is
-- lost — it just stops driving the screen until somebody confirms what a
-- night drop is dated.
--
-- Restores from jb_store_days_backup_052 rather than recomputing, so this is
-- exact rather than a second guess. Idempotent.
-- =====================================================================

\set ON_ERROR_STOP on

\echo ''
\echo '=== what is about to be restored ==='
select coalesce(rn.name, '(no run)') as run, s.name as store,
       jb_days_sorted(s.delivery_days) as days_052_gave_them,
       jb_days_sorted(b.delivery_days) as restoring_to
  from stores s
  join jb_store_days_backup_052 b on b.store_id = s.id
  left join runs rn on rn.id = s.default_run_id
 where rn.name in ('Central Coast', 'City', 'North West')
   and jb_days_sorted(s.delivery_days) is distinct from jb_days_sorted(b.delivery_days)
 order by rn.name, s.name;

update stores s
   set delivery_days = b.delivery_days
  from jb_store_days_backup_052 b, runs rn
 where b.store_id = s.id
   and rn.id = s.default_run_id
   and rn.name in ('Central Coast', 'City', 'North West')
   and jb_days_sorted(s.delivery_days) is distinct from jb_days_sorted(b.delivery_days);

-- And the runs themselves, back to what they held before 052.
update runs r
   set run_days = b.run_days
  from jb_run_backup_052 b
 where b.run_id = r.id
   and r.name in ('Central Coast', 'City', 'North West')
   and jb_days_sorted(r.run_days) is distinct from jb_days_sorted(b.run_days);

-- Clear the evening marks on these three. They name days the run does not go.
update runs
   set run_pm = '{}'
 where name in ('Central Coast', 'City', 'North West')
   and cardinality(run_pm) > 0;

\echo ''
\echo '=== the three runs, after ==='
select r.name,
       array_to_string(r.run_days::text[], ',')                         as days,
       coalesce(nullif(array_to_string(r.run_pm::text[], ','), ''), '-') as evening,
       (select count(*) from stores s where s.default_run_id = r.id and s.active) as stores
  from runs r
 where r.name in ('Central Coast', 'City', 'North West')
 order by r.name;

\echo ''
\echo '=== THE TEST: scheduled days vs the days vans actually went ==='
\echo '    For these three runs, stores_scheduled and stores_delivered should'
\echo '    now line up on every day. A day with one number high and the other'
\echo '    at zero means the revert did not take.'
with dn(day) as (values ('mon'),('tue'),('wed'),('thu'),('fri'),('sat'),('sun')),
sched as (
  select coalesce(rn.name,'(no run)') as run, s.id as store_id, dn.day,
         (dn.day = any(s.delivery_days::text[])) as scheduled,
         (select count(distinct d.delivery_date)
            from deliveries d
           where d.store_id = s.id
             and (array['sun','mon','tue','wed','thu','fri','sat'])
                   [extract(dow from d.delivery_date)::int + 1] = dn.day) as drops
    from stores s
    left join runs rn on rn.id = s.default_run_id
    cross join dn
   where s.active and rn.name in ('Central Coast','City','North West')
)
select run, day,
       count(*) filter (where scheduled)   as stores_scheduled,
       count(*) filter (where drops > 0)   as stores_delivered
  from sched
 group by run, day
having count(*) filter (where scheduled) > 0 or count(*) filter (where drops > 0) > 0
 order by run, array_position(array['mon','tue','wed','thu','fri','sat','sun'], day);

\echo ''
\echo '=== nothing outside those three runs moved ==='
select coalesce(rn.name,'(no run)') as run, count(*) as stores_still_differing_from_backup
  from stores s
  join jb_store_days_backup_052 b on b.store_id = s.id
  left join runs rn on rn.id = s.default_run_id
 where jb_days_sorted(s.delivery_days) is distinct from jb_days_sorted(b.delivery_days)
 group by rn.name order by 2 desc;

\echo ''
\echo '=== and the seven blank invoice cafes are still blank ==='
select count(*) filter (where coalesce(cardinality(delivery_days),0) = 0) as blank_should_be_7,
       count(*) as active
  from stores where active;

-- Undo:
--   update stores s set delivery_days = '{sun,wed,fri}' where ... (see 052)
--   ...or simply re-run 052's second half. The backup tables are unchanged.
