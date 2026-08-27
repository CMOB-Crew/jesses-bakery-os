-- =====================================================================
-- Migration 059: finish 058. Two things it got wrong.
--
-- ---------------------------------------------------------------------
-- FAULT 1 — the babka insert had no `kind`
-- ---------------------------------------------------------------------
-- events.kind is `event_kind not null`, an enum from 001. The Jewish holidays
-- were loaded by 008 as kind='store_custom', ui_kind='jewish'. 058's INSERT
-- supplied neither and the constraint stopped it. The challah UPDATE before it
-- had already committed, so the state right now is: challah loaves corrected,
-- babka missing, Yom Kippur still on 056's store list.
--
-- ---------------------------------------------------------------------
-- FAULT 2 — `name ilike '%challah%'` is far too wide, and this is the real one
-- ---------------------------------------------------------------------
-- 058 printed its own product list and it should have stopped me:
--
--   21 products matched, including
--     100GR CHALLAH DOUGH BALLS
--     200GR CHALLAH DOUGH BALLS
--     CHALLAH DOUGH (1 KG BAGS)
--     MEDIUM CHALLAH - PLAIN / POPPY / SESAME / WATER / WHOLEMEAL
--     CHALLAH - GLUTEN FREE, CHALLAH - RYE, CHALLAH - SPELT, ...
--
-- A lift was measured on THREE of them: RAISIN, SEMISWEET SESAME, SEMISWEET
-- PLAIN. The rest are either dormant lines or, worse, DOUGH — sold by the
-- kilo to other bakers. Multiplying a wholesale dough order by 3.3 because it
-- has "challah" in the name is exactly the kind of thing that looks fine in a
-- migration and turns up as a pallet of dough nobody ordered.
--
-- ---------------------------------------------------------------------
-- THE RULE THIS USES INSTEAD
-- ---------------------------------------------------------------------
-- A product is in scope only if all three hold:
--
--   1. it is a challah loaf or a babka — NOT dough, NOT a mini pack
--   2. it has actually sold in the last 180 days
--      (180, not 42: the Coles feed died on 8 Aug and a 42-day window would
--       mark every Coles-only line dormant. 180 reaches back through Coles'
--       live period.)
--   3. its lift, or its family's, was measured — printed below so the list
--      can be read rather than trusted
--
-- Rule 2 is the engine's own gate for what it will plan at all, so the event
-- scope and the plan scope now agree. A product the engine will never plan
-- does not need an uplift.
--
-- Reversible via jb_events_backup_056. Idempotent.
-- =====================================================================

\set ON_ERROR_STOP on

\echo ''
\echo '=== EVERY challah/babka product, and whether it belongs in scope ==='
\echo '    sold_180d is the engine gate. lift_2025 is what was measured over'
\echo '    the four days to the Rosh Hashanah eve, where there was enough to'
\echo '    measure. A dash means the line was dormant that season.'
with win as (
  select (date '2025-09-22' - g.n)::date as d from generate_series(0,3) g(n)
),
base as (
  select w.d as win_day, (w.d - 7*k.n)::date as bd
    from win w cross join generate_series(1,3) k(n)
),
w as (
  select sd.product_id, sum(sd.units_sold)::numeric as u
    from win join sales_daily sd on sd.sale_date = win.d group by 1
),
b as (
  select sd.product_id, sum(sd.units_sold)::numeric / 3 as u
    from base join sales_daily sd on sd.sale_date = base.bd group by 1
),
recent as (
  select sd.product_id, sum(sd.units_sold) as u
    from sales_daily sd
   where sd.sale_date > jb_asof() - 180 and sd.sale_date <= jb_asof()
   group by 1
)
select p.name as product,
       coalesce(recent.u, 0)                                   as sold_180d,
       round(coalesce(b.u, 0))                                 as rh2025_baseline,
       round(coalesce(w.u, 0))                                 as rh2025_holiday,
       case when coalesce(b.u,0) >= 20
            then round(100.0 * (coalesce(w.u,0) - b.u) / b.u)::text || '%'
            else '-' end                                       as lift_2025,
       case when p.name ilike '%dough%'          then 'NO — dough, sold by weight'
            when p.name ilike '%mini%challah%'   then 'NO — minis are flat'
            when coalesce(recent.u, 0) = 0       then 'NO — dormant'
            when p.name ilike '%babka%'          then 'BABKA +290%'
            else 'CHALLAH LOAVES +230%' end                     as treatment
  from products p
  left join w      on w.product_id      = p.id
  left join b      on b.product_id      = p.id
  left join recent on recent.product_id = p.id
 where p.name ilike '%challah%' or p.name ilike '%babka%'
 order by 6, coalesce(recent.u,0) desc, 1;

-- ---------------------------------------------------------------------
-- Apply
-- ---------------------------------------------------------------------
update events e
   set product_ids = (
         select array_agg(p.id) from products p
          where p.name ilike '%challah%'
            and p.name not ilike '%mini%'
            and p.name not ilike '%dough%'
            and exists (select 1 from sales_daily sd
                         where sd.product_id = p.id
                           and sd.sale_date > jb_asof() - 180
                           and sd.sale_date <= jb_asof()))
 where e.name = 'Rosh Hashanah - challah loaves';

insert into events (name, kind, ui_kind, state, start_date, end_date,
                    uplift_pct, product_ids, store_ids, note)
select 'Rosh Hashanah - babka',
       src.kind, src.ui_kind, src.state, src.start_date, src.end_date,
       290,
       (select array_agg(p.id) from products p
         where p.name ilike '%babka%'
           and exists (select 1 from sales_daily sd
                        where sd.product_id = p.id
                          and sd.sale_date > jb_asof() - 180
                          and sd.sale_date <= jb_asof())),
       src.store_ids,
       'Chocolate babka 50->259 and cinnamon 58->163 over the four days to the 2025 eve; 4->48 in 2024. Two years agreeing on direction, one with a usable magnitude, same standard as the challah loaves.'
  from events src
 where src.name = 'Rosh Hashanah - challah loaves'
   and not exists (select 1 from events where name = 'Rosh Hashanah - babka');

update events e
   set uplift_pct  = 290,
       product_ids = (
         select array_agg(p.id) from products p
          where p.name ilike '%babka%'
            and exists (select 1 from sales_daily sd
                         where sd.product_id = p.id
                           and sd.sale_date > jb_asof() - 180
                           and sd.sale_date <= jb_asof())),
       store_ids   = (select store_ids from events where name = 'Rosh Hashanah - challah loaves')
 where e.name = 'Rosh Hashanah - babka';

-- Yom Kippur: 058 never reached this. Same stores, and the whole challah
-- family including the minis, because -13% is a mild reduction and both years
-- agree the group softens.
update events e
   set store_ids   = (select store_ids from events where name = 'Rosh Hashanah - challah loaves'),
       product_ids = (
         select array_agg(p.id) from products p
          where p.name ilike '%challah%'
            and p.name not ilike '%dough%'
            and exists (select 1 from sales_daily sd
                         where sd.product_id = p.id
                           and sd.sale_date > jb_asof() - 180
                           and sd.sale_date <= jb_asof()))
 where e.name = 'Yom Kippur';

\echo ''
\echo '=== every event, after ==='
select e.name, e.start_date, e.uplift_pct,
       coalesce(cardinality(e.store_ids), 0)   as stores,
       coalesce(cardinality(e.product_ids), 0) as products
  from events e order by e.start_date, e.name;

\echo ''
\echo '=== exactly which products each holiday event now moves ==='
select e.name as event, p.name as product
  from events e join products p on p.id in (select unnest(e.product_ids))
 where e.product_ids is not null
 order by e.name, p.name;

\echo ''
\echo '=== CHECK 1: no product in both Rosh Hashanah events — ZERO rows ==='
select p.name as counted_twice
  from products p
 where p.id in (select unnest(product_ids) from events where name = 'Rosh Hashanah - challah loaves')
   and p.id in (select unnest(product_ids) from events where name = 'Rosh Hashanah - babka');

\echo ''
\echo '=== CHECK 2: no dough and no minis in any uplift event — ZERO rows ==='
select e.name as event, p.name as product
  from events e join products p on p.id in (select unnest(e.product_ids))
 where e.uplift_pct > 0
   and (p.name ilike '%dough%' or p.name ilike '%mini%challah%');

\echo ''
\echo '=== CHECK 3: every scoped product actually sells — ZERO rows ==='
select e.name as event, p.name as dormant_product
  from events e join products p on p.id in (select unnest(e.product_ids))
 where e.product_ids is not null
   and not exists (select 1 from sales_daily sd
                    where sd.product_id = p.id
                      and sd.sale_date > jb_asof() - 180
                      and sd.sale_date <= jb_asof());

-- Undo:
--   delete from events where name = 'Rosh Hashanah - babka';
--   update events e set name = 'Rosh Hashanah', uplift_pct = b.uplift_pct,
--          store_ids = b.store_ids, product_ids = b.product_ids
--     from jb_events_backup_056 b where b.id = e.id;
