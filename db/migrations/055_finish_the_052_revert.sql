-- =====================================================================
-- Migration 055: finish undoing 052's store-day change. Five stores left.
--
-- 052 rewrote stores.delivery_days from Sahil's email. It has been wrong
-- every time it has been checked against what the vans actually did:
--
--   053  restored 77 stores that had their OWN schedules, which 052 had
--        flattened onto their run's days. A creche went from one delivery a
--        week to seven.
--   054  restored 33 stores on Central Coast, City and North West, where the
--        delivery records were unanimous and contradicted 052 outright.
--
-- Five stores remain on 052's days. They are on runs 054 deliberately left
-- alone, because those runs disagree with their schedules only partially.
-- But these five are not a partial disagreement — they are the same edit from
-- the same source, and the run-level counts point the same way:
--
--   South East   run delivers on tue/thu/sun MORE often than scheduled
--                (tue 13 scheduled / 17 delivered, thu 14/17, sun 12/15)
--                and LESS on mon/wed/fri (mon 10/7, wed 8/5, fri 16/13).
--                052 moved three stores OFF tue/thu/sun ONTO mon/wed/fri.
--
--   North Shore  8 stores got a Friday delivery, only 5 are scheduled for one.
--                052 took Friday OFF two stores.
--
-- One of the two is Woolworths St Ives, 548 units a week.
--
-- The evidence for these five is weaker than for the three runs in 054 — it
-- is run-level rather than store-level, because with one week of history a
-- single store's missing day could be a skipped delivery. So this migration
-- PRINTS the per-store evidence before it writes, and the write is a restore
-- from the snapshot rather than a fresh guess.
--
-- After this, stores.delivery_days is exactly what it was before 052 for
-- every store in the network. 052's run_days changes stay — they do not
-- drive the engine, which scopes on stores.delivery_days.
--
-- Idempotent.
-- =====================================================================

\set ON_ERROR_STOP on

\echo ''
\echo '=== THE EVIDENCE — the five stores, day by day, over the week we have ==='
\echo '    on_052 = the day 052 gave them. on_backup = the day they had before.'
\echo '    drops  = times a van actually turned up.'
\echo '    A day with on_backup=yes and drops=1 is a delivery 052 hid.'
\echo '    A day with on_052=yes and drops=0 is one 052 invented.'
with dn(day) as (values ('mon'),('tue'),('wed'),('thu'),('fri'),('sat'),('sun'))
select coalesce(rn.name,'(no run)') as run, s.name as store, dn.day,
       case when dn.day = any(s.delivery_days::text[])  then 'yes' else '-' end as on_052,
       case when dn.day = any(b.delivery_days::text[])  then 'yes' else '-' end as on_backup,
       (select count(distinct d.delivery_date)
          from deliveries d
         where d.store_id = s.id
           and (array['sun','mon','tue','wed','thu','fri','sat'])
                 [extract(dow from d.delivery_date)::int + 1] = dn.day) as drops
  from stores s
  join jb_store_days_backup_052 b on b.store_id = s.id
  left join runs rn on rn.id = s.default_run_id
  cross join dn
 where jb_days_sorted(s.delivery_days) is distinct from jb_days_sorted(b.delivery_days)
   and (dn.day = any(s.delivery_days::text[]) or dn.day = any(b.delivery_days::text[]))
 order by rn.name, s.name,
          array_position(array['mon','tue','wed','thu','fri','sat','sun'], dn.day);

-- Restore every remaining store to its pre-052 days.
update stores s
   set delivery_days = b.delivery_days
  from jb_store_days_backup_052 b
 where b.store_id = s.id
   and jb_days_sorted(s.delivery_days) is distinct from jb_days_sorted(b.delivery_days);

\echo ''
\echo '=== ZERO ROWS NOW — every store back to its pre-052 days ==='
select coalesce(rn.name,'(no run)') as run, s.name,
       jb_days_sorted(s.delivery_days) as now_is,
       jb_days_sorted(b.delivery_days) as should_be
  from stores s
  join jb_store_days_backup_052 b on b.store_id = s.id
  left join runs rn on rn.id = s.default_run_id
 where jb_days_sorted(s.delivery_days) is distinct from jb_days_sorted(b.delivery_days);

\echo ''
\echo '=== THE NETWORK NUMBER — scheduled vs actual, every active store ==='
\echo '    Before any of today: 1,647 agreed / 89 van-no-schedule / 112 schedule-no-van.'
\echo '    Both mismatch columns should now be materially smaller.'
with dn(day) as (values ('mon'),('tue'),('wed'),('thu'),('fri'),('sat'),('sun')),
sched as (
  select s.id, dn.day,
         (dn.day = any(s.delivery_days::text[])) as scheduled,
         (select count(distinct d.delivery_date)
            from deliveries d
           where d.store_id = s.id
             and (array['sun','mon','tue','wed','thu','fri','sat'])
                   [extract(dow from d.delivery_date)::int + 1] = dn.day) as drops
    from stores s cross join dn where s.active
)
select count(*)                                                   as store_days,
       count(*) filter (where scheduled = (drops > 0))            as agreed,
       count(*) filter (where not scheduled and drops > 0)        as van_no_schedule,
       count(*) filter (where scheduled and drops = 0)            as schedule_no_van
  from sched;

\echo ''
\echo '=== and the seven blank invoice cafes are still blank ==='
select count(*) filter (where coalesce(cardinality(delivery_days),0) = 0) as blank_should_be_7,
       count(*) as active
  from stores where active;

-- Undo: re-run 052's second half. jb_store_days_backup_052 is unchanged.
