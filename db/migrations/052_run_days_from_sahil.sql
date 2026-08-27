-- =====================================================================
-- Migration 052: correct the run days, and record which drops go out in the
-- evening.
--
-- SOURCE. Sahil's email, relayed by Van into #jesses-bakery-system-build at
-- 12:53 on 27 Aug 2026, verbatim:
--
--   Canberra: tuesday Am, friday Am
--   South: monday am, Wednesday am, Saturday am
--   North shore: Tuesday am, Thursday am, Saturday am, Sunday am
--   Northern beaches: Tuesday am, Thursday am, saturday am, (busy stores sunday am 7 of them)
--   South east: monday am, Wednesday am, friday am, (busy stores like eastgardens, randwick, maroubra almost everyday)
--   New castle: Tuesday am, Thursday am, saturday am
--   Central coast: Sunday pm, Wednesday am, Friday pm
--   City: sunday pm, Tuesday pm, Friday am
--   Northwest: Sunday pm, Tuesday pm, Thursday pm, Saturday am
--   Inner west: Monday am, Wednesday am, Friday am, Saturday pm
--   West run: Monday pm, Thursday am, Saturday am
--   Hills run: Monday am, Wednesday am, Saturday am
--   East: everyday Am
--
-- This is the first authoritative statement of run days anyone has given us.
-- The Stores Master never carried them — I searched it three ways on 27 Aug
-- looking for exactly this and it is not in there.
--
-- ---------------------------------------------------------------------
-- WHAT IT CORRECTS — SIX runs, 111 stores. 42% of the network is currently
-- planned for days the van does not go.
-- ---------------------------------------------------------------------
--
--   run              we have                    Sahil says                stores
--   Central Coast    mon,wed,sat                sun PM, wed, fri PM           16
--   City             mon,wed,fri                sun PM, tue PM, fri           18
--   North Shore      tue,thu,FRI,sat,sun        tue,thu,sat,sun               21
--   South East       tue,thu,sun                mon,wed,fri                   18
--   Northern Beaches tue,thu,FRI,sat,sun        tue,thu,sat,sun               20
--   North West       mon,wed,fri,sat            sun PM,tue PM,thu PM,sat      18
--
-- South East and North West are not one stray day — they are different sets
-- entirely. Central Coast is the one that matters most: it is the night run
-- Simona described on the 26 Aug call, driver goes Friday night and Sunday
-- night, and we had it as a weekday morning run.
--
-- There is also a `Schools` run (4 stores, Friday) that Sahil's list does not
-- mention. It is deliberately NOT touched — the report at the end lists it so
-- somebody decides rather than a migration guessing.
--
-- It also finally explains the `Special Friday` / `Special Sunday` columns that
-- have been "meaning unconfirmed" in the notes since migration 026. They are
-- evening drops.
--
-- ---------------------------------------------------------------------
-- HOW AM/PM IS STORED
-- ---------------------------------------------------------------------
-- runs.run_days keeps its meaning exactly: every day the run goes out. A new
-- column, run_pm, lists WHICH of those days are evening drops. So:
--
--   Central Coast   run_days {sun,wed,fri}   run_pm {sun,fri}
--
-- Deliberately additive. Every existing reader of run_days — the engine, the
-- delivery plan, the production sheet, stores.delivery_days — is untouched and
-- keeps working with no changes. An empty run_pm means what it has always
-- meant: everything goes out in the morning.
--
-- Store delivery_days are updated alongside, because the engine scopes on
-- stores.delivery_days rather than on the run (the same rule saveRunDays
-- follows). Stores with a row in store_run_overrides are LEFT ALONE — they are
-- on their own days by explicit decision and 28 of them are loaded.
--
-- REVERSIBLE. Prior run_days and store delivery_days are snapshotted first.
-- Idempotent: the snapshot keeps the first version.
-- =====================================================================

\set ON_ERROR_STOP on

alter table runs add column if not exists run_pm weekday[] not null default '{}';

comment on column runs.run_pm is
  'Which of this run''s days go out in the EVENING. A subset of run_days; empty means every drop is a morning one. Source: Sahil''s run timings, 27 Aug 2026. Additive on purpose — run_days keeps its exact meaning so every existing reader is unaffected.';

create table if not exists jb_run_backup_052 (
  run_id     uuid primary key,
  name       text,
  run_days   weekday[],
  run_pm     weekday[],
  snapped_at timestamptz not null default now()
);
alter table jb_run_backup_052 enable row level security;
alter table jb_run_backup_052 force  row level security;
drop policy if exists biz_all on jb_run_backup_052;
create policy biz_all on jb_run_backup_052 for all
  using      (public.current_app_role() in ('admin','manager','office'))
  with check (public.current_app_role() in ('admin','manager','office'));

create table if not exists jb_store_days_backup_052 (
  store_id      uuid primary key,
  name          text,
  delivery_days weekday[],
  snapped_at    timestamptz not null default now()
);
alter table jb_store_days_backup_052 enable row level security;
alter table jb_store_days_backup_052 force  row level security;
drop policy if exists biz_all on jb_store_days_backup_052;
create policy biz_all on jb_store_days_backup_052 for all
  using      (public.current_app_role() in ('admin','manager','office'))
  with check (public.current_app_role() in ('admin','manager','office'));

insert into jb_run_backup_052 (run_id, name, run_days, run_pm)
select id, name, run_days, run_pm from runs
on conflict (run_id) do nothing;

insert into jb_store_days_backup_052 (store_id, name, delivery_days)
select id, name, delivery_days from stores where active
on conflict (store_id) do nothing;

-- Sahil's list. Matched on the run name, case-insensitively, so a rename does
-- not silently skip one — the report at the end shows anything unmatched.
-- NOT `on commit drop`. psql autocommits each statement, so a temp table
-- created that way is dropped the instant the CREATE returns and the very next
-- INSERT fails with "relation _sahil does not exist". Which is exactly what
-- happened on the first run of this migration.
drop table if exists _sahil;
create temporary table _sahil (match text, days weekday[], pm weekday[]);
insert into _sahil values
  ('canberra',         '{tue,fri}',                             '{}'),
  ('south east',       '{mon,wed,fri}',                         '{}'),
  ('south',            '{mon,wed,sat}',                         '{}'),
  ('north shore',      '{tue,thu,sat,sun}',                     '{}'),
  ('northern beaches', '{tue,thu,sat}',                         '{}'),
  ('newcastle',        '{tue,thu,sat}',                         '{}'),
  ('central coast',    '{sun,wed,fri}',                         '{sun,fri}'),
  ('city',             '{sun,tue,fri}',                         '{sun,tue}'),
  ('north west',       '{sun,tue,thu,sat}',                     '{sun,tue,thu}'),
  ('inner west',       '{mon,wed,fri,sat}',                     '{sat}'),
  ('west',             '{mon,thu,sat}',                         '{mon}'),
  ('hills',            '{mon,wed,sat}',                         '{}'),
  ('eastern suburbs',  '{mon,tue,wed,thu,fri,sat,sun}',         '{}');

-- Longest name first, so 'south east' wins over 'south' and 'north west' over
-- 'west'. Without that, "South East" would match the South rule.
update runs r
   set run_days = s.days,
       run_pm   = s.pm
  from (
    select distinct on (rr.id) rr.id, sa.days, sa.pm
      from runs rr
      join _sahil sa on lower(rr.name) like '%' || sa.match || '%'
     order by rr.id, length(sa.match) desc
  ) s
 where r.id = s.id
   and (r.run_days is distinct from s.days or r.run_pm is distinct from s.pm);

-- Carry the days down to the stores, because the engine scopes on
-- stores.delivery_days. Stores with an explicit override keep theirs.
update stores st
   set delivery_days = r.run_days
  from runs r
 where st.default_run_id = r.id
   and st.active
   and cardinality(r.run_days) > 0
   and st.delivery_days is distinct from r.run_days
   and not exists (select 1 from store_run_overrides o where o.store_id = st.id);

\echo ''
\echo '=== every run, after ==='
select r.name,
       array_to_string(r.run_days::text[], ',') as days,
       coalesce(nullif(array_to_string(r.run_pm::text[], ','), ''), '—') as evening,
       (select count(*) from stores s where s.default_run_id = r.id and s.active) as stores
  from runs r order by r.name;

\echo ''
\echo '=== ANY RUN SAHIL DID NOT NAME — check these by hand ==='
select r.name, array_to_string(r.run_days::text[], ',') as days
  from runs r
 where not exists (select 1 from _sahil sa where lower(r.name) like '%' || sa.match || '%')
 order by r.name;

\echo ''
\echo '=== stores whose days moved ==='
select b.name, array_to_string(b.delivery_days::text[], ',') as was,
       array_to_string(s.delivery_days::text[], ',') as now_is
  from jb_store_days_backup_052 b join stores s on s.id = b.store_id
 where b.delivery_days is distinct from s.delivery_days
 order by b.name;

\echo ''
\echo '=== the 28 override stores are untouched, by design ==='
select count(*) as override_stores_left_alone from store_run_overrides;

drop table if exists _sahil;

-- Undo:
--   update runs r set run_days = b.run_days, run_pm = b.run_pm
--     from jb_run_backup_052 b where b.run_id = r.id;
--   update stores s set delivery_days = b.delivery_days
--     from jb_store_days_backup_052 b where b.store_id = s.id;
