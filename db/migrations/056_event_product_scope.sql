-- =====================================================================
-- Migration 056: an event can move some PRODUCTS and not others.
--
-- ---------------------------------------------------------------------
-- WHY — measured, from two prior high-holiday seasons in sales_daily
-- ---------------------------------------------------------------------
-- Four days to the Rosh Hashanah eve, against the same four weekdays
-- averaged over the three preceding weeks:
--
--                          challah        everything else
--   Rosh Hashanah 2024     +103.7%             -2.0%
--   Rosh Hashanah 2025      +85.5%             -3.1%
--
-- Challah roughly doubles. Everything else goes slightly BACKWARDS. Both
-- years agree. The events table carries a single blanket 12% for the whole
-- basket, which is wrong twice over: challah is under-ordered about sevenfold
-- and sourdough gets 12% added in a week it declines.
--
-- Per product, 2025 (the year with a real baseline — see below):
--   CHALLAH - RAISIN            84 ->  889
--   CHALLAH - SEMISWEET SESAME 376 ->  900
--   CHALLAH - SEMISWEET PLAIN  320 ->  797
--   BABKAS - CHOCOLATE          50 ->  259
--   ...while BAGEL - PLAIN -10%, SOURDOUGH - WHITE -5%, DARK RYE -11%.
--
-- ---------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES **NOT** TRUST
-- ---------------------------------------------------------------------
-- The 2024 per-product percentages are discarded. Raisin challah reads
-- +9628% because its baseline was FIVE units across the whole network — those
-- lines barely existed in Sept 2024. A percentage on a baseline of five is
-- not a measurement.
--
-- Sukkot 2024's +54% is discarded outright as a DATA ARTIFACT. The Coles feed
-- begins between 11 and 13 Oct 2024: the Sukkot window (13-16 Oct) contains
-- 115 Coles stores and 3,765 units, its baseline weeks contain none. That is
-- a feed switching on mid-comparison, not demand. Sukkot 2025 (-9.3%) is the
-- only clean reading and one year is not enough to encode, so Sukkot is set
-- to ZERO and the reason recorded, rather than keeping a +8% nobody measured.
--
-- Rosh Hashanah and Yom Kippur 2024 exclude Coles from BOTH window and
-- baseline, so those percentages are internally consistent — measured on
-- Woolworths and Harris Farm only, which is why they are used as
-- corroboration of 2025 rather than averaged with it.
--
-- ---------------------------------------------------------------------
-- THE NUMBERS SET HERE
-- ---------------------------------------------------------------------
--   Rosh Hashanah   challah products, at the stores that measurably lifted
--                   +90%   (2025 says +85.5, 2024 says +103.7)
--   Yom Kippur      challah products     -13%   (2025 -9.2, 2024 -18.2)
--   Sukkot          0, pending a second clean year
--
-- Nothing is applied to non-challah lines, because both years say they do not
-- move up.
--
-- Reversible: events are snapshotted into jb_events_backup_056 first.
-- Idempotent.
-- =====================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- 1. The column, mirroring store_ids from 036.
-- ---------------------------------------------------------------------
alter table events add column if not exists product_ids uuid[];

comment on column events.product_ids is
  'Which products this event moves. NULL means every product, so existing events are unaffected. Added because Rosh Hashanah doubles challah while everything else declines 3% — a single basket-wide percentage cannot express that. Measured over the 2024 and 2025 seasons.';

create table if not exists jb_events_backup_056 (
  id           uuid primary key,
  name         text,
  start_date   date,
  end_date     date,
  uplift_pct   numeric,
  state        text,
  store_ids    uuid[],
  product_ids  uuid[],
  snapped_at   timestamptz not null default now()
);
alter table jb_events_backup_056 enable row level security;
alter table jb_events_backup_056 force  row level security;
drop policy if exists biz_all on jb_events_backup_056;
create policy biz_all on jb_events_backup_056 for all
  using      (public.current_app_role() in ('admin','manager','office'))
  with check (public.current_app_role() in ('admin','manager','office'));

insert into jb_events_backup_056 (id, name, start_date, end_date, uplift_pct, state, store_ids, product_ids)
select id, name, start_date, end_date, uplift_pct, state, store_ids, product_ids from events
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2. Who lifts. Derived from the 2025 season, which is the one with a real
--    baseline and the Coles feed present throughout.
-- ---------------------------------------------------------------------
drop table if exists _rh_scope;
create temporary table _rh_scope as
with win as (
  select (date '2025-09-22' - g.n)::date as d from generate_series(0,3) g(n)
),
base as (
  select w.d as win_day, (w.d - 7*k.n)::date as bd
    from win w cross join generate_series(1,3) k(n)
),
ch as (select id from products where name ilike '%challah%'),
w as (
  select sd.store_id, sum(sd.units_sold)::numeric as units
    from win join sales_daily sd on sd.sale_date = win.d
    join ch on ch.id = sd.product_id
   group by 1
),
b as (
  select sd.store_id, sum(sd.units_sold)::numeric / 3 as units
    from base join sales_daily sd on sd.sale_date = base.bd
    join ch on ch.id = sd.product_id
   group by 1
)
select coalesce(w.store_id, b.store_id)      as store_id,
       coalesce(b.units, 0)                  as baseline,
       coalesce(w.units, 0)                  as holiday
  from w full join b on b.store_id = w.store_id;

\echo ''
\echo '=== the stores this will scope Rosh Hashanah to ==='
\echo '    Rule: sold challah in the run-up, and more than in the weeks before.'
\echo '    A baseline floor of 5 keeps a store that sold 1 and then 3 out of it.'
select s.name as store, s.retailer::text,
       round(r.baseline) as challah_baseline, round(r.holiday) as challah_holiday,
       round(100.0 * (r.holiday - r.baseline) / nullif(r.baseline,0), 0) as uplift_pct
  from _rh_scope r join stores s on s.id = r.store_id
 where r.holiday > r.baseline * 1.15 and r.baseline >= 5 and s.active
 order by (r.holiday - r.baseline) desc;

\echo ''
\echo '=== how that compares with "every store that ranges challah today" ==='
select (select count(*) from _rh_scope r join stores s on s.id = r.store_id
         where r.holiday > r.baseline * 1.15 and r.baseline >= 5 and s.active) as measured_lifters,
       (select count(distinct spr.store_id) from store_product_ranging spr
          join products p on p.id = spr.product_id
         where p.name ilike '%challah%' and coalesce(spr.ranged, true))        as stores_ranging_challah,
       (select count(*) from stores where active)                              as active_stores;

-- ---------------------------------------------------------------------
-- 3. Apply.
-- ---------------------------------------------------------------------
update events e
   set uplift_pct = 90,
       product_ids = (select array_agg(id) from products where name ilike '%challah%'),
       store_ids   = (select array_agg(r.store_id)
                        from _rh_scope r join stores s on s.id = r.store_id
                       where r.holiday > r.baseline * 1.15
                         and r.baseline >= 5 and s.active)
 where e.name = 'Rosh Hashanah';

update events e
   set uplift_pct = -13,
       product_ids = (select array_agg(id) from products where name ilike '%challah%'),
       store_ids   = (select array_agg(r.store_id)
                        from _rh_scope r join stores s on s.id = r.store_id
                       where r.holiday > r.baseline * 1.15
                         and r.baseline >= 5 and s.active)
 where e.name = 'Yom Kippur';

-- Sukkot: the only clean year says -9.3%, one year is not enough, and its
-- 2026 dates overlap the Spring school holidays event (-30%), which the engine
-- SUMS. Encoding a guess on top of that overlap would compound two unknowns.
update events
   set uplift_pct = 0
 where name like 'Sukkot%';

\echo ''
\echo '=== every event, after ==='
select e.name, e.start_date, e.end_date, e.uplift_pct, coalesce(e.state,'(national)') as state,
       coalesce(cardinality(e.store_ids), 0)   as stores,
       case when e.product_ids is null then 'ALL products'
            else cardinality(e.product_ids)::text || ' products' end as scope
  from events e order by e.start_date;

\echo ''
\echo '=== the products Rosh Hashanah will now move ==='
-- NOT `p.id = any((select product_ids ...))`. Postgres reads ANY(subquery) as
-- the subquery form and compares the uuid against each ROW, which is a
-- uuid[] — "operator does not exist: uuid = uuid[]". unnest is the form that
-- works. This statement failed on the first run of 056; the migration's real
-- work had already committed, but ON_ERROR_STOP then skipped 057.
select p.name
  from products p
 where p.id in (select unnest(product_ids) from events where name like 'Rosh Hashanah%')
 order by p.name;

drop table if exists _rh_scope;

-- Undo:
--   update events e set uplift_pct = b.uplift_pct, store_ids = b.store_ids,
--          product_ids = b.product_ids
--     from jb_events_backup_056 b where b.id = e.id;
