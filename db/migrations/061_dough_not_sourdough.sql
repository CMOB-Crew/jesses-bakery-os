-- =====================================================================
-- Migration 061: "sourdough" contains "dough".
--
-- 059 excluded dough lines from the Rosh Hashanah scope with
--
--     and p.name not ilike '%dough%'
--
-- meaning to catch these, which are wholesale ingredient lines sold by
-- weight and have no business being tripled for a holiday:
--
--     100GR CHALLAH DOUGH BALLS
--     200GR CHALLAH DOUGH BALLS
--     CHALLAH DOUGH (1 KG BAGS)
--
-- It also caught this, which is a loaf:
--
--     CHALLAH - SOURDOUGH        <- sourDOUGH
--
-- Spotted on the Delivery sheet's production panel, which lists
-- CHALLAH - SOURDOUGH under the sourdough team at 9 units. It is bread.
--
-- NO BEHAVIOUR CHANGES TODAY. That line has zero sales in the last 180
-- days, so 059's second rule excluded it regardless and the event scope is
-- byte-identical either way. This is a latent fault: the day that line wakes
-- up it would be silently left out of the holiday bake, and nobody would
-- think to look at a substring match written weeks earlier.
--
-- The fix is to name the dough products rather than pattern-match a word
-- that appears inside a different one.
-- =====================================================================

\set ON_ERROR_STOP on

\echo ''
\echo '=== what the two patterns disagree about ==='
select p.name,
       (p.name ilike '%dough%')                                     as caught_by_059,
       (p.name ilike '%dough ball%' or p.name ilike '%challah dough%') as caught_by_061,
       coalesce((select sum(sd.units_sold) from sales_daily sd
                  where sd.product_id = p.id
                    and sd.sale_date > jb_asof() - 180
                    and sd.sale_date <= jb_asof()), 0)               as sold_180d
  from products p
 where p.name ilike '%dough%'
 order by 2 desc, 1;

update events e
   set product_ids = (
         select array_agg(p.id) from products p
          where p.name ilike '%challah%'
            and p.name not ilike '%mini%'
            and p.name not ilike '%dough ball%'
            and p.name not ilike '%challah dough%'
            and exists (select 1 from sales_daily sd
                         where sd.product_id = p.id
                           and sd.sale_date > jb_asof() - 180
                           and sd.sale_date <= jb_asof()))
 where e.name = 'Rosh Hashanah - challah loaves';

update events e
   set product_ids = (
         select array_agg(p.id) from products p
          where p.name ilike '%challah%'
            and p.name not ilike '%dough ball%'
            and p.name not ilike '%challah dough%'
            and exists (select 1 from sales_daily sd
                         where sd.product_id = p.id
                           and sd.sale_date > jb_asof() - 180
                           and sd.sale_date <= jb_asof()))
 where e.name = 'Yom Kippur';

\echo ''
\echo '=== the scope, unchanged in practice — same products as before ==='
select e.name as event, p.name as product
  from events e join products p on p.id in (select unnest(e.product_ids))
 where e.name like 'Rosh Hashanah%' or e.name = 'Yom Kippur'
 order by e.name, p.name;

\echo ''
\echo '=== CHECK: no dough BALLS or bagged dough in any event — ZERO rows ==='
select e.name as event, p.name as product
  from events e join products p on p.id in (select unnest(e.product_ids))
 where p.name ilike '%dough ball%' or p.name ilike '%challah dough%';

\echo ''
\echo '=== and CHALLAH - SOURDOUGH is now classed as bread, not dough ==='
select p.name,
       case when p.name ilike '%dough ball%' or p.name ilike '%challah dough%'
            then 'dough — excluded' else 'bread — eligible' end as class,
       coalesce((select sum(sd.units_sold) from sales_daily sd
                  where sd.product_id = p.id
                    and sd.sale_date > jb_asof() - 180
                    and sd.sale_date <= jb_asof()), 0) as sold_180d,
       'dormant today, so not in the event either way' as note
  from products p where p.name ilike '%challah - sourdough%';
