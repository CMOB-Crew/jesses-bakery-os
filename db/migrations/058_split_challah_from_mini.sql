-- =====================================================================
-- Migration 058: correct 056. "Challah" is two products behaving differently,
-- and averaging them produced a number wrong for both.
--
-- ---------------------------------------------------------------------
-- WHAT 056 GOT WRONG
-- ---------------------------------------------------------------------
-- 056 set Rosh Hashanah to +90% on everything matching '%challah%', from a
-- measured group figure of +85.5% (2025). That group is not one thing:
--
--   2025, four days to the eve          baseline   holiday    lift
--     CHALLAH - RAISIN                        84       889   +962%
--     CHALLAH - SEMISWEET SESAME             376       900   +139%
--     CHALLAH - SEMISWEET PLAIN              320       797   +149%
--     ------------------------------------------------------------
--     full challah loaves                    780     2,586   +231%
--
--     MINI CHALLAH - SESAME (X 4)            749       925    +23%
--     MINI CHALLAH - PLAIN (X 4)             897       990    +10%
--     ------------------------------------------------------------
--     mini challah                         1,646     1,915    +16%
--
-- +85.5% is the blend of those two, and it is wrong for both: it orders less
-- than half what the loaves need and nearly six times what the minis need.
--
-- 2024 says the same thing from the other direction. Full challah went 28 ->
-- 966 on a baseline too small to give a usable percentage but plenty large
-- enough to establish the direction. Minis went 889 -> 900, flat, in a year
-- when the loaves multiplied thirty-fold.
--
-- ---------------------------------------------------------------------
-- BABKA — 056 missed it entirely
-- ---------------------------------------------------------------------
--     BABKAS - CHOCOLATE   2025:  50 -> 259   (2024:  4 -> 48)
--     BABKAS - CINNAMON    2025:  58 -> 163
--     combined 2025: 108 -> 422, +291%
--
-- Same evidential standard as the challah loaves: two years agreeing on
-- direction, one year with a usable magnitude. Treated the same way.
--
-- ---------------------------------------------------------------------
-- THE NUMBERS
-- ---------------------------------------------------------------------
--   Rosh Hashanah - challah loaves   +230%   name like challah, NOT mini
--   Rosh Hashanah - babka            +290%   name like babka
--   mini challah                        0    flat in both years; no event
--   Yom Kippur                        -13%   unchanged, all challah lines
--                                            (2025 -9.2, 2024 -18.2, agreed)
--
-- The engine SUMS uplift_pct across events matching a (store, product, date).
-- The two Rosh Hashanah events cover disjoint product sets, so nothing
-- double-counts. Verified at the end.
--
-- ---------------------------------------------------------------------
-- STORE SCOPE — tightened
-- ---------------------------------------------------------------------
-- 056 took any store with a challah baseline of 5+ that lifted 15%+. That let
-- in a tail moving one or two loaves — Woolworths Ashfield 6 -> 7, Coles
-- Chittaway Point 5 -> 6. A +230% uplift on noise is still noise, multiplied.
-- Now also requires at least 3 extra loaves. The dropped stores are printed
-- rather than silently discarded.
--
-- Reversible via jb_events_backup_056. Idempotent.
-- =====================================================================

\set ON_ERROR_STOP on

-- Recompute the 2025 scope, now with an absolute floor as well as a ratio.
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
select coalesce(w.store_id, b.store_id) as store_id,
       coalesce(b.units, 0)             as baseline,
       coalesce(w.units, 0)             as holiday
  from w full join b on b.store_id = w.store_id;

\echo ''
\echo '=== stores 056 included that this DROPS — one or two loaves is not a lift ==='
select s.name as store, round(r.baseline) as baseline, round(r.holiday) as holiday,
       round(r.holiday - r.baseline) as extra
  from _rh_scope r join stores s on s.id = r.store_id
 where s.active and r.baseline >= 5 and r.holiday > r.baseline * 1.15
   and (r.holiday - r.baseline) < 3
 order by 4 desc, 1;

\echo ''
\echo '=== the product split this migration is built on ==='
select case when p.name ilike '%mini%challah%' then 'mini challah — NO event'
            when p.name ilike '%challah%'      then 'challah loaves — +230%'
            when p.name ilike '%babka%'        then 'babka — +290%'
       end                              as treatment,
       count(*)                         as products,
       string_agg(p.name, ', ' order by p.name) as which
  from products p
 where p.name ilike '%challah%' or p.name ilike '%babka%'
 group by 1 order by 1;

-- ---------------------------------------------------------------------
-- Apply
-- ---------------------------------------------------------------------
update events e
   set name        = 'Rosh Hashanah - challah loaves',
       uplift_pct  = 230,
       product_ids = (select array_agg(id) from products
                       where name ilike '%challah%' and name not ilike '%mini%'),
       store_ids   = (select array_agg(r.store_id)
                        from _rh_scope r join stores s on s.id = r.store_id
                       where s.active and r.baseline >= 5
                         and r.holiday > r.baseline * 1.15
                         and (r.holiday - r.baseline) >= 3)
 where e.name in ('Rosh Hashanah', 'Rosh Hashanah - challah loaves');

-- Babka rides the same dates, stores and evidential standard.
insert into events (name, start_date, end_date, uplift_pct, product_ids, store_ids)
select 'Rosh Hashanah - babka',
       (select start_date from events where name = 'Rosh Hashanah - challah loaves'),
       (select end_date   from events where name = 'Rosh Hashanah - challah loaves'),
       290,
       (select array_agg(id) from products where name ilike '%babka%'),
       (select store_ids from events where name = 'Rosh Hashanah - challah loaves')
 where not exists (select 1 from events where name = 'Rosh Hashanah - babka');

update events e
   set uplift_pct  = 290,
       product_ids = (select array_agg(id) from products where name ilike '%babka%'),
       store_ids   = (select store_ids from events where name = 'Rosh Hashanah - challah loaves')
 where e.name = 'Rosh Hashanah - babka';

-- Yom Kippur keeps the whole challah group and the same store scope.
update events e
   set store_ids = (select store_ids from events where name = 'Rosh Hashanah - challah loaves')
 where e.name = 'Yom Kippur';

\echo ''
\echo '=== every event, after ==='
select e.name, e.start_date, e.uplift_pct,
       coalesce(cardinality(e.store_ids), 0) as stores,
       case when e.product_ids is null then 'ALL products'
            else cardinality(e.product_ids)::text || ' products' end as scope
  from events e order by e.start_date, e.name;

\echo ''
\echo '=== the products each Rosh Hashanah event moves ==='
select e.name as event, p.name as product
  from events e
  join products p on p.id in (select unnest(e.product_ids))
 where e.name like 'Rosh Hashanah%'
 order by e.name, p.name;

\echo ''
\echo '=== NO DOUBLE COUNTING — must return ZERO rows ==='
\echo '    The engine sums uplift across matching events. A product in both'
\echo '    Rosh Hashanah events would be lifted twice.'
select p.name as product_in_two_events
  from products p
 where p.id in (select unnest(product_ids) from events where name = 'Rosh Hashanah - challah loaves')
   and p.id in (select unnest(product_ids) from events where name = 'Rosh Hashanah - babka');

\echo ''
\echo '=== and mini challah is in NO Rosh Hashanah event — must be ZERO rows ==='
select p.name as mini_challah_wrongly_scoped
  from products p
 where p.name ilike '%mini%challah%'
   and p.id in (select unnest(product_ids) from events where name like 'Rosh Hashanah%');

drop table if exists _rh_scope;

-- Undo:
--   delete from events where name = 'Rosh Hashanah - babka';
--   update events e set name = 'Rosh Hashanah', uplift_pct = b.uplift_pct,
--          store_ids = b.store_ids, product_ids = b.product_ids
--     from jb_events_backup_056 b where b.id = e.id;
