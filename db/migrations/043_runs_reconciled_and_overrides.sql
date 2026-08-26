-- =====================================================================
-- Migration 043: make the runs table say what Simona means by a run,
-- and load the fourteen stores that ride a different one on set days.
--
-- WHAT WAS WRONG
--
-- The legacy Stores_Master carries TWO different ideas of a run:
--
--   Region   EASTERN SUBURBS, HILLS, SOUTH...   set for all 331 stores
--   Run_ID   1..6                               set for 95, blank for the rest
--
-- Both were loaded. Region became the regions table AND fourteen named runs,
-- each with real run_days. Run_ID became twenty unnamed "Run N" rows — one per
-- (number, region) pair — with run_days = '{}'.
--
-- stores.default_run_id points at the SECOND one. So:
--
--   * 170 of 265 active stores have no run at all,
--   * the 95 that do point at a row called "Run 5" with no delivery days,
--   * and all fourteen named runs — the names Simona actually uses, and the
--     names in her own override columns — have zero stores on them.
--
-- Migration 026 recorded half of this at the time and deferred the rest:
-- "Note runs.run_days is empty '{}' for all six runs, and only 95 of 265 active
-- stores have a default_run_id at all... NOT modelled here, deliberately: the
-- per-day Override columns (the Maroubra rule). Needs the run data loaded
-- first." This is that.
--
-- WHY REPOINTING IS SAFE, checked rather than assumed
--
-- On production, right now:
--
--   select ... from pg_class  where pg_get_viewdef(oid) ilike '%default_run_id%'  -> 0 rows
--   select ... from pg_proc   where prosrc          ilike '%default_run_id%'      -> 0 rows
--
-- Nothing reads this column. Not jb_plan_day, not one view, not one function.
-- The forecast engine scopes on stores.delivery_days (migration 026), which this
-- migration does not touch. So the blast radius is the store page's delivery
-- panel and nothing else.
--
-- WHAT IS DELIBERATELY NOT DESTROYED
--
-- The twenty legacy "Run N" rows stay in the runs table. Within North Shore and
-- Hills the old data split stores across two run numbers, which MAY encode two
-- real vans. There is nothing else on those rows to model it with — no name, no
-- days, and two thirds of the network missing — so it cannot be the delivery
-- model today. But the mapping stays recoverable from both the runs table and
-- Stores_Master.csv, and section D below prints exactly who was affected. If
-- Simona later says North Shore is two vans, nothing has been lost.
--
-- THE OVERRIDES
--
-- Thirty rows in her sheet, all thirty verified against production before this
-- was written: every store resolves, every target run exists. Two do not get
-- loaded, and both are named rather than silently dropped:
--
--   IGA LINDFIELD  thu -> NORTH SHORE.  Lindfield IS in North Shore. That is
--     not an override, it is the store's own run written out longhand. Loading
--     it would create a row that stops moving with the store the next time its
--     run changes.
--
--   WOOLWORTHS METRO BRONTE  wed -> EASTERN SUBURBS.  Bronte does not deliver
--     on a Wednesday — not in her sheet, not in our data. An override for a day
--     with no delivery is inert, and worse, the store page's save would delete
--     it the first time anyone opened Edit, so it would look loaded and then
--     quietly vanish. Section H prints Bronte's actual Wednesday delivery
--     history so we can settle which of the two is stale.
--
-- That leaves 28 real overrides across 13 stores.
--
-- Idempotent. Safe to re-run: the repoint is an UPDATE to a derived value and
-- the overrides are deleted-then-inserted from a fixed list.
-- =====================================================================

\timing on
\set ON_ERROR_STOP on

\echo ''
\echo '=== A. BEFORE ==='
select (select count(*) from store_run_overrides) as override_rows,
       count(*) filter (where s.active and s.default_run_id is null) as active_no_run,
       count(*) filter (where s.active and cardinality(rn.run_days) = 0) as active_on_a_dayless_run,
       count(*) filter (where s.active and cardinality(rn.run_days) > 0) as active_on_a_real_run
  from stores s left join runs rn on rn.id = s.default_run_id;

begin;

-- Snapshot the OLD mapping to a REAL table before touching it. This is the one
-- part of this migration that would otherwise be irreversible: the repoint is
-- derived and can be recomputed, but the legacy Run_ID assignment lives nowhere
-- else in the database once it is overwritten. With this, it does.
--
-- `on conflict do nothing` means the FIRST snapshot wins — re-running this
-- migration must not overwrite the original with post-repoint values.
create table if not exists jb_run_repoint_backup_043 (
  store_id           uuid primary key references stores(id) on delete cascade,
  region_id          uuid,
  old_default_run_id uuid,
  snapped_at         timestamptz not null default now()
);
comment on table jb_run_repoint_backup_043 is
  'Pre-043 stores.default_run_id, i.e. the legacy Stores_Master Run_ID mapping. Kept because 043 repoints every store at its region''s named run and this is the only copy of what it said before. To undo 043 part B: update stores s set default_run_id = b.old_default_run_id from jb_run_repoint_backup_043 b where b.store_id = s.id.';

insert into jb_run_repoint_backup_043 (store_id, region_id, old_default_run_id)
select s.id, s.region_id, s.default_run_id
  from stores s
 where s.active and s.default_run_id is not null
on conflict (store_id) do nothing;

-- Enrol it like every other business table (migration 014 pattern), so the RLS
-- coverage guard stays green.
alter table jb_run_repoint_backup_043 enable row level security;
alter table jb_run_repoint_backup_043 force  row level security;
drop policy if exists biz_all on jb_run_repoint_backup_043;
create policy biz_all on jb_run_repoint_backup_043
  for all
  using      (public.current_app_role() in ('admin','manager','office'))
  with check (public.current_app_role() in ('admin','manager','office'));

-- ---------------------------------------------------------------------
-- B. Point every store at the named run for its region.
--
-- The named run is the one in that region WITH delivery days set; the legacy
-- "Run N" rows in the same region have none. A region with no named run, or
-- more than one, is left completely alone rather than guessed at.
-- ---------------------------------------------------------------------
with named as (
  select rn.region_id, min(rn.id::text)::uuid as run_id, count(*) as n
    from runs rn
   where cardinality(rn.run_days) > 0
   group by rn.region_id
  having count(*) = 1
)
update stores s
   set default_run_id = n.run_id
  from named n
 where s.region_id = n.region_id
   and s.default_run_id is distinct from n.run_id;

\echo ''
\echo '=== C. AFTER the repoint: stores on each named run ==='
select rn.name as run,
       array_to_string(rn.run_days::text[], ',') as run_days,
       count(s.id) filter (where s.active) as active_stores
  from runs rn
  left join stores s on s.default_run_id = rn.id
 where cardinality(rn.run_days) > 0
 group by rn.name, rn.run_days
 order by 3 desc;

\echo ''
\echo '=== D. NOT LOST: regions whose legacy Run_ID split across more than one row ==='
\echo '    (kept in the runs table and in Stores_Master.csv; nothing deleted)'
select reg.name as region,
       rn.name  as legacy_run_it_was_on,
       count(*) as stores
  from jb_run_repoint_backup_043 b
  join regions reg on reg.id = b.region_id
  join runs    rn  on rn.id  = b.old_default_run_id
 where b.region_id in (
   -- regions where the old data put stores on more than one legacy run row
   select b2.region_id from jb_run_repoint_backup_043 b2 group by b2.region_id
    having count(distinct b2.old_default_run_id) > 1)
 group by 1,2 order by 1,3 desc;

-- ---------------------------------------------------------------------
-- E. The per-day overrides — the Maroubra rule.
--
-- Source: SUN_OVERRIDE..SAT_OVERRIDE in Stores_Master.csv. Resolved by legacy
-- store id and by run name, both verified against production before this ran.
-- ---------------------------------------------------------------------
create temp table _ov (legacy_id text, day text, target text) on commit drop;
insert into _ov values
  ('STO004','wed','EASTERN SUBURBS'),('STO004','fri','EASTERN SUBURBS'),
  ('STO027','mon','SOUTH'),('STO027','wed','EASTERN SUBURBS'),('STO027','sat','EASTERN SUBURBS'),
  ('STO030','mon','HILLS'),('STO030','wed','EASTERN SUBURBS'),('STO030','fri','SOUTH'),('STO030','sat','EASTERN SUBURBS'),
  ('STO032','sat','EASTERN SUBURBS'),
  ('STO039','mon','EASTERN SUBURBS'),('STO039','wed','EASTERN SUBURBS'),('STO039','sat','EASTERN SUBURBS'),
  ('STO040','mon','EASTERN SUBURBS'),('STO040','sat','EASTERN SUBURBS'),
  ('STO041','mon','SOUTH'),('STO041','wed','EASTERN SUBURBS'),('STO041','sat','EASTERN SUBURBS'),
  ('STO044','sat','EASTERN SUBURBS'),
  ('STO055','thu','NORTH SHORE'),
  ('STO068','sat','NORTHERN BEACHES'),
  ('STO114','mon','INNER WEST'),('STO114','wed','INNER WEST'),('STO114','fri','INNER WEST'),
  ('STO117','wed','EASTERN SUBURBS'),('STO117','fri','EASTERN SUBURBS'),
  ('STO305','sat','EASTERN SUBURBS'),
  ('STO329','mon','EASTERN SUBURBS'),('STO329','wed','EASTERN SUBURBS'),('STO329','sat','EASTERN SUBURBS');

-- Resolve once; everything below reads this.
create temp table _res on commit drop as
select o.legacy_id,
       o.day,
       o.target,
       s.id   as store_id,
       s.name as store_name,
       rn.id  as run_id,
       (o.day = any(s.delivery_days::text[]))       as delivers_that_day,
       (rn.id = s.default_run_id)                   as same_as_own_run
  from _ov o
  join stores s on upper(s.legacy_store_id) = o.legacy_id
  join runs   rn on upper(rn.name) = o.target;

\echo ''
\echo '=== E1. rows NOT loaded, and why ==='
select legacy_id, store_name, day, target,
       case when same_as_own_run then 'that is already this store''s own run'
            when not delivers_that_day then 'store has no delivery on that day'
       end as reason
  from _res
 where same_as_own_run or not delivers_that_day
 order by legacy_id, day;

\echo ''
\echo '=== E2. loaded, but worth knowing: the target run does not normally go out'
\echo '    on that day. Her sheet says the store rides it anyway. Loaded as-is —'
\echo '    it is her data, not ours to correct — but flagged rather than buried. ==='
select r.legacy_id, r.store_name, r.day, r.target,
       array_to_string(rn.run_days::text[], ',') as that_run_normally_goes
  from _res r join runs rn on rn.id = r.run_id
 where r.delivers_that_day and not r.same_as_own_run
   and not (r.day = any(rn.run_days::text[]))
 order by r.legacy_id, r.day;

-- Idempotent: clear this store set, then write the current answer.
delete from store_run_overrides o
 where o.store_id in (select store_id from _res);

insert into store_run_overrides (store_id, day, run_id)
select store_id, day::weekday, run_id
  from _res
 where delivers_that_day
   and not same_as_own_run
on conflict (store_id, day) do update set run_id = excluded.run_id;

commit;

\echo ''
\echo '=== F. AFTER: what production now holds ==='
select s.name as store,
       coalesce(dr.name,'(no run)') as normally_on,
       o.day::text as day,
       r.name as rides_with
  from store_run_overrides o
  join stores s on s.id = o.store_id
  join runs   r on r.id = o.run_id
  left join runs dr on dr.id = s.default_run_id
 order by s.name, array_position(array['mon','tue','wed','thu','fri','sat','sun'], o.day::text);

\echo ''
\echo '=== G. totals ==='
select (select count(*) from store_run_overrides) as override_rows,
       (select count(distinct store_id) from store_run_overrides) as stores_with_overrides,
       count(*) filter (where s.active and s.default_run_id is null) as active_still_with_no_run
  from stores s;

\echo ''
\echo '=== H. the Bronte question: does it ACTUALLY get a Wednesday drop? ==='
\echo '    If this shows real Wednesday deliveries, its delivery_days are wrong,'
\echo '    not the override. If it shows none, the override row is stale.'
select to_char(d.delivery_date,'Dy') as dow,
       count(*) as deliveries,
       min(d.delivery_date) as first_seen,
       max(d.delivery_date) as last_seen
  from deliveries d
  join stores s on s.id = d.store_id
 where upper(s.legacy_store_id) = 'STO039'
   and d.delivery_date > current_date - 120
 group by 1
 order by 2 desc;

\echo ''
\echo '--- 043 APPLIED. ---'
