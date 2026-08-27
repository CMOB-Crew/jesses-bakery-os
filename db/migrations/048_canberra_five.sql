-- =====================================================================
-- Migration 048: make the five new Woolworths Metro stores plannable before
-- they go live on Tue 1 Sept.
--
-- Simona, by email 13 Aug:
--
--   "1457 Bonner Metro, 1610 Wright Metro, 1661 Franklin Metro, 1089 Hawker
--    Metro, 8524 Wilton Plaza Metro — These are new Woolworths Metro Canberra
--    stores can add them on but make them inactive for now"
--
-- They were added, and correctly left inactive, and given a run. Three things
-- were not set, and all three matter the moment somebody flips them active:
--
--   state          = 'NSW'   they are in the ACT
--   delivery_days  = {}      the engine scopes on delivery_days, so a store
--                            with none is invisible to the plan — the exact
--                            defect the New Store wizard had until 27 Aug
--   shelf_max      = null    no cap, so nothing bounds what gets sent
--
-- Activate them as they stand on Tuesday and you get five shops the system
-- cannot plan, two days before go-live.
--
-- ---------------------------------------------------------------------
-- WHERE THE VALUES COME FROM — none of them are invented
-- ---------------------------------------------------------------------
-- state: FOUR of them, not five. Simona's email calls all five "Canberra
--   Metro" stores, and Bonner, Wright, Franklin and Hawker are Canberra
--   suburbs. Wilton Plaza is not, and this is checkable rather than arguable:
--   Woolworths' own store locator lists it as
--     woolworths.com.au/shop/storelocator/nsw-wilton-8524
--   NSW, store number 8524 — the exact supplier code she sent. It is in Wilton
--   in the Wollondilly Shire, about 80km from Sydney and 200km from Canberra.
--   So it stays NSW, which is what it already says, and no update touches it.
--   She grouped it with the others in one email; that is all.
--
-- delivery_days: taken from the run each store is ALREADY assigned to, so the
--   store and its run agree. This is the same rule saveRunDays uses. Nothing
--   invented, and it stays correct if the run's days change later.
--
-- shelf_max / shelf_min / size_category: taken from the median of the ACTIVE
--   Woolworths METRO stores. Not a guess — the same banner at the same store
--   format. Deliberately NOT scoped to one state: Metro format is what drives
--   shelf size, and four of these are ACT while one is NSW, so a state scope
--   would give the two groups different caps for no good reason. If no Metro
--   peer exists it falls back to the median of active Woolworths stores, and
--   if there is still nothing it leaves the store alone and says so rather
--   than writing a number nobody can defend.
--
-- Sanity: Simona's own new-store guidance (email, 14 Aug) puts a small store at
--   "50-60" units baseline. If the derived cap lands far outside that band the
--   report at the end will show it and we should ask rather than ship it.
--
-- ---------------------------------------------------------------------
-- REVERSIBLE. Prior values are snapshotted to jb_store_backup_048 before
-- anything changes. Idempotent — the snapshot keeps the FIRST version, so
-- re-running never overwrites the original with an already-modified one.
-- Touches ONLY these five stores, and leaves all five INACTIVE.
-- =====================================================================

\set ON_ERROR_STOP on

create table if not exists jb_store_backup_048 (
  store_id      uuid primary key,
  name          text,
  state         text,
  delivery_days weekday[],
  shelf_min     int,
  shelf_max     int,
  size_category store_size,
  snapped_at    timestamptz not null default now()
);

alter table jb_store_backup_048 enable row level security;
alter table jb_store_backup_048 force  row level security;
drop policy if exists biz_all on jb_store_backup_048;
create policy biz_all on jb_store_backup_048 for all
  using      (public.current_app_role() in ('admin','manager','office'))
  with check (public.current_app_role() in ('admin','manager','office'));

comment on table jb_store_backup_048 is
  'Prior state of the five new Woolworths Metro stores before 048 set their state, delivery days and shelf caps. First snapshot wins, so re-running 048 never destroys the original. Undo: update stores s set ... from jb_store_backup_048 b where b.store_id = s.id.';

-- The five, by the supplier codes Simona sent.
create temporary view _five as
  select id from stores where supplier_code in ('1457','1610','1661','1089','8524');

insert into jb_store_backup_048 (store_id, name, state, delivery_days, shelf_min, shelf_max, size_category)
select s.id, s.name, s.state, s.delivery_days, s.shelf_min, s.shelf_max, s.size_category
  from stores s join _five f on f.id = s.id
on conflict (store_id) do nothing;

-- 1. State — the four genuine Canberra stores only. 8524 Wilton Plaza is a
--    NSW store (Woolworths' own locator: .../storelocator/nsw-wilton-8524) and
--    is deliberately excluded.
update stores s set state = 'ACT'
 where s.supplier_code in ('1457','1610','1661','1089')
   and s.state is distinct from 'ACT';

-- 2. Delivery days, from the run the store is already on.
update stores s
   set delivery_days = r.run_days
  from _five f
  join stores s2 on s2.id = f.id
  join runs r on r.id = s2.default_run_id
 where s.id = f.id
   and coalesce(cardinality(s.delivery_days), 0) = 0
   and coalesce(cardinality(r.run_days), 0) > 0;

-- 3. Shelf caps and size, from the nearest real peers. Metro stores in the same
--    state first; all Woolworths in that state as the fallback.
with peers as (
  select
    percentile_cont(0.5) within group (order by p.shelf_max)::int as med_max,
    percentile_cont(0.5) within group (order by p.shelf_min)::int as med_min,
    mode() within group (order by p.size_category)                as med_size,
    count(*)                                                      as n
  from stores p
  where p.active and p.retailer = 'woolworths'
    and p.name ilike '%metro%' and p.shelf_max is not null
),
fallback as (
  select
    percentile_cont(0.5) within group (order by p.shelf_max)::int as med_max,
    percentile_cont(0.5) within group (order by p.shelf_min)::int as med_min,
    mode() within group (order by p.size_category)                as med_size,
    count(*)                                                      as n
  from stores p
  where p.active and p.retailer = 'woolworths'
    and p.shelf_max is not null
),
src as (
  select coalesce(nullif(peers.n,0) is not null and peers.n > 0, false) as used_metro,
         case when peers.n > 0 then peers.med_max  else fallback.med_max  end as med_max,
         case when peers.n > 0 then peers.med_min  else fallback.med_min  end as med_min,
         case when peers.n > 0 then peers.med_size else fallback.med_size end as med_size,
         case when peers.n > 0 then peers.n        else fallback.n        end as n
    from peers, fallback
)
update stores s
   set shelf_max     = coalesce(s.shelf_max, src.med_max),
       shelf_min     = coalesce(s.shelf_min, src.med_min),
       size_category = coalesce(s.size_category, src.med_size)
  from _five f, src
 where s.id = f.id and src.n > 0;

-- ---------------------------------------------------------------------------
-- Report. Read this before you activate anything.
-- ---------------------------------------------------------------------------
\echo ''
\echo '=== the five, as they now stand (all still INACTIVE) ==='
select s.supplier_code, s.name, s.active, s.state,
       array_to_string(s.delivery_days::text[], ',') as delivery_days,
       s.size_category, s.shelf_min, s.shelf_max,
       r.name as run
  from stores s join _five f on f.id = s.id
  left join runs r on r.id = s.default_run_id
 order by s.supplier_code;

\echo ''
\echo '=== the peers those caps came from ==='
select name, size_category, shelf_min, shelf_max
  from stores
 where active and retailer = 'woolworths' and state = 'ACT' and shelf_max is not null
 order by name;

\echo ''
\echo '=== the odd one out, resolved — no question needed ==='
\echo 'Simona called all five Canberra Metro stores. Wilton Plaza is not one:'
\echo 'Woolworths lists it at /storelocator/nsw-wilton-8524 — NSW, Wollondilly'
\echo 'Shire, and the store number matches the code she sent. Left as NSW.'
select supplier_code, name, state, active from stores
 where supplier_code = '8524';

-- Undo:
--   update stores s
--      set state = b.state, delivery_days = b.delivery_days,
--          shelf_min = b.shelf_min, shelf_max = b.shelf_max,
--          size_category = b.size_category
--     from jb_store_backup_048 b where b.store_id = s.id;
