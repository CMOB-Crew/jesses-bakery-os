-- =====================================================================
-- Migration 063: the Seasonality calendar tells the truth about scoped events.
--
-- ---------------------------------------------------------------------
-- WHAT IS ON SCREEN RIGHT NOW
-- ---------------------------------------------------------------------
-- September 2026, the four Rosh Hashanah days:
--
--     Thu 10  x4.27     Fri 11  x5.14     Sat 12  x5.71     Sun 13  x6.00
--
-- The weekday shape for those days is 0.89 / 1.07 / 1.19 / 1.25. Every one of
-- those is the shape multiplied by 4.80, and 4.80 is 1 + (90 + 290)/100: the
-- challah event's +90% ADDED to the babka event's +290%.
--
-- The page is telling Simona that Sunday 13 September is a six-times-normal
-- bake day. Measured against the engine's own predicate, the real network
-- effect of that day is +4.3%. The page is out by a factor of 4.6.
--
-- ---------------------------------------------------------------------
-- WHY
-- ---------------------------------------------------------------------
-- SeasonalityCalendar.tsx dayMult():
--
--     const pct = eventsOn(key).filter(movesThePlan)
--                              .reduce((a, e) => a + e.uplift, 0);
--     return BASE[dow] * (1 + pct / 100);
--
-- ADDING is correct. jb_plan_day does sum(uplift_pct)/100 and there is a
-- comment in that component explaining why summing beats compounding. The
-- fault is not the arithmetic, it is the POPULATION the arithmetic runs over:
--
--     the engine  sums per (store, product), over only the events matching
--                 that specific pair
--     the page    sums every event on the day and prints one number for the
--                 whole network
--
-- Before 056 every event was network-wide and the two agreed. 036 added store
-- scope, 056 added product scope, and nothing taught the calendar about
-- either. The two Rosh Hashanah events move DISJOINT product sets (059 check
-- 1) at a subset of stores, so no product anywhere gets +380%. Verified: the
-- maximum uplift carried by any single (store, product) pair across those four
-- days is 290, and zero pairs sit at 380 or above.
--
-- ---------------------------------------------------------------------
-- THE FIX: GIVE EACH EVENT A WEIGHT
-- ---------------------------------------------------------------------
-- An event's effect on a network day is its uplift times the share of the
-- network its scope actually covers:
--
--     challah   +90% x  3.02% of planned units  =  +2.71%
--     babka    +290% x  0.46% of planned units  =  +1.35%
--                                                  ------
--                                       the day     +4.06%
--
-- against +4.31% measured directly off sales. Same neighbourhood, and the
-- residual is the plan window's weekday mix, discussed below.
--
-- A network-wide event has share = 1.0 and is therefore UNCHANGED by this.
-- Christmas stays +40%. Nothing regresses.
--
-- ---------------------------------------------------------------------
-- WHY THE WEIGHT COMES FROM THE PLAN AND NOT FROM SALES
-- ---------------------------------------------------------------------
-- Seasonality is force-dynamic, so this view runs on EVERY page load.
--
--     sales_daily,  375 MB, 56-day aggregate     2,814 ms
--     replenishment_plans,  4.8 MB, whole table    223 ms
--
-- 2.8 seconds behind a page render is not shippable. The plan table is also
-- the more honest denominator: it contains the engine's universe by
-- construction — active stores still reporting — so it cannot be polluted by
-- stores that have history but no future. That polluted denominator is exactly
-- what made my first attempt at this measurement read half the true value:
-- weighting off raw sales_daily put the 115 dark Coles stores in the bottom of
-- every fraction and never in the top, and a network-wide event came out at
-- 55% reach instead of 100%.
--
-- LIMIT, stated: the plan covers 12 days, so its weekday mix is not exactly
-- 1.71 of each day. Challah is a Thu/Fri line, so its share moves a little
-- with where the window falls. It is a display weight on a lever Simona
-- reviews, not an input to the plan — the engine never reads this view.
--
-- ---------------------------------------------------------------------
-- SECOND FAULT, FOUND WHILE MEASURING THE FIRST
-- ---------------------------------------------------------------------
-- The event card says "moves 38 stores". The engine will move TWENTY.
--
-- stores_affected is cardinality(store_ids) and asks nothing about whether
-- those stores are active or still reporting. All 18 of the missing ones are
-- Coles, every one last reporting on 2026-08-08 — the feed outage, uniform to
-- the day, no individual store gone quiet on its own.
--
-- So the store list is RIGHT and the count is WRONG, and it un-wrongs itself
-- the moment Simona sends the Coles files. That is precisely why this adds
-- stores_live as a separate column instead of correcting stores_affected in
-- place: the page needs to show a number that moves with the data, and it
-- needs to be able to say "38 scoped, 20 the engine can reach today" rather
-- than silently swapping one frozen number for another.
--
-- ---------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES NOT DO
-- ---------------------------------------------------------------------
-- It does not change a single event, rate, window, store list or product list.
-- No plan output changes. jb_plan_day never reads this view. This is a
-- reporting view and the whole change is what the screen says.
--
-- Report 5 below is the open question it deliberately leaves open: the +90%
-- was anchored on the eve-to-normal-Friday ratio across all 38 stores, and the
-- 18 that are dark lifted +297% in 2025 against the surviving 20 at +202%. If
-- Coles does not come back before 10 September the rate is being applied to a
-- population that lifts a little softer than the one it was derived from.
-- Report 5 recomputes the anchor on the 20 alone so the size of that is known
-- rather than assumed. Nothing is changed on the strength of it here.
--
-- Idempotent. Reversible — the undo at the foot restores 036's view verbatim.
-- =====================================================================

\set ON_ERROR_STOP on

\echo ''
\echo '=== BEFORE: what the view says today ==='
select name, uplift_pct, stores_affected from v_event_scope order by start_date, name;

\echo ''
\echo '=== the views RLS mode, for the record. NOT changed by this migration. ==='
\echo '    Recorded because this view is about to read replenishment_plans,'
\echo '    stores and regions. Under definer rights it runs as the owner as it'
\echo '    does now; under invoker the app role needs select on those three,'
\echo '    which it already has (the Deliveries board reads all of them).'
select c.relname,
       coalesce((select option_value from pg_options_to_table(c.reloptions)
                  where option_name = 'security_invoker'), 'not set') as security_invoker
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relname = 'v_event_scope';

-- ---------------------------------------------------------------------
-- The view.
--
-- create or replace requires the existing columns to keep their names, types
-- and ORDER, and permits only appending. id .. stores_affected below are
-- byte-for-byte 036's, so nothing reading the old shape breaks.
-- ---------------------------------------------------------------------
create or replace view v_event_scope as
with plan_rows as (
  -- The engine's universe, with each row's state attached once rather than
  -- resolved per event via a correlated subquery.
  select rp.store_id,
         rp.product_id,
         rp.recommended_qty::numeric as qty,
         reg.state::text             as state
    from replenishment_plans rp
    join stores s   on s.id  = rp.store_id
    left join regions reg on reg.id = s.region_id
),
plan_tot as (
  -- nullif so an empty or un-run plan table yields NULL, not zero. A NULL
  -- share is the signal for "no weight available"; a zero share would read as
  -- "this event does nothing", which is a different and much worse claim.
  select nullif(sum(qty), 0) as u from plan_rows
),
per_event as (
  select e.id,
         coalesce(sum(pr.qty), 0)          as u,
         count(distinct pr.store_id)::int  as stores_live
    from events e
    left join plan_rows pr
           -- All FOUR predicates from jb_plan_day's uplift CTE. An earlier
           -- draft of this omitted the state test and every NSW-scoped event
           -- read as national: Spring school holidays weighted 100% instead of
           -- 93.55%, which would have put -30% on the whole network in the
           -- calendar instead of -28%.
           on (e.state is null or e.state = pr.state)
          and (e.product_ids is null or pr.product_id = any(e.product_ids))
          and (case
                 when e.store_ids is not null then pr.store_id = any(e.store_ids)
                 when e.store_id  is not null then pr.store_id = e.store_id
                 else true
               end)
   group by e.id
)
select e.id,
       e.name,
       e.start_date,
       e.end_date,
       e.uplift_pct,
       e.state,
       case
         when e.store_ids is not null then cardinality(e.store_ids)
         when e.store_id  is not null then 1
         else (select count(*)::int from stores s
                where s.active
                  and (e.state is null
                       or e.state = (select r.state from regions r where r.id = s.region_id)))
       end as stores_affected,
       -- ---- appended by 063 ----
       pe.stores_live,
       cardinality(e.product_ids)                                      as products_scoped,
       round(pe.u / pt.u, 6)                                           as share_of_plan,
       round(e.uplift_pct * pe.u / pt.u, 3)                            as day_effect_pct
  from events e
  join per_event pe on pe.id = e.id
  cross join plan_tot pt;

comment on view v_event_scope is
  'What each calendar event will actually move. stores_affected is the store LIST length; stores_live is how many of those the engine can reach today (active and still reporting), and the gap is normally a dark retailer feed. share_of_plan is the fraction of planned units the event scope covers and day_effect_pct is uplift_pct times that share -- the events real effect on a network day, which is what the Seasonality calendar cell must show. A network-wide event has share 1.0 and day_effect_pct equal to its uplift. share_of_plan is NULL when the plan table is empty; treat NULL as no weight available and fall back to the raw uplift rather than reading it as zero.';

\echo ''
\echo '=== 1. AFTER: reach and real day effect, every event ==='
\echo '    stores_affected is the list. stores_live is what the engine reaches.'
\echo '    day_effect_pct is what the calendar cell should now carry.'
select name,
       uplift_pct,
       stores_affected,
       stores_live,
       coalesce(products_scoped::text, 'all')       as products,
       round(100 * share_of_plan, 2)                as share_of_plan_pct,
       day_effect_pct
  from v_event_scope
 order by start_date, name;

\echo ''
\echo '=== 2. THE FOUR ROSH HASHANAH DAYS, before and after ==='
\echo '    was_mult is what the page prints today. now_mult is the shape times'
\echo '    the summed day_effect. The measured truth is +4.3%.'
with shape as (
  select * from (values
    ('2026-09-10'::date, 'Thu', 0.89::numeric),
    ('2026-09-11'::date, 'Fri', 1.07),
    ('2026-09-12'::date, 'Sat', 1.19),
    ('2026-09-13'::date, 'Sun', 1.25)) v(d, dow, base)
),
eff as (
  select sh.d, sh.dow, sh.base,
         coalesce(sum(v.uplift_pct), 0)    as raw_sum,
         coalesce(sum(v.day_effect_pct), 0) as weighted_sum
    from shape sh
    left join v_event_scope v
           on sh.d between v.start_date and v.end_date
   group by 1,2,3
)
select d, dow,
       base                                          as weekday_shape,
       raw_sum                                       as summed_uplift_was,
       round(base * (1 + raw_sum/100), 2)            as was_mult,
       weighted_sum                                  as weighted_uplift_now,
       round(base * (1 + weighted_sum/100), 2)       as now_mult
  from eff order by d;

\echo ''
\echo '=== 3. GUARD: no network-wide event may have moved ==='
\echo '    An event with no store, state or product scope must weight 1.0 and'
\echo '    its day_effect must equal its uplift exactly. ZERO rows expected.'
select e.name, v.uplift_pct, v.day_effect_pct, v.share_of_plan
  from events e join v_event_scope v on v.id = e.id
 where e.store_ids is null and e.store_id is null
   and e.product_ids is null and e.state is null
   and (v.share_of_plan is distinct from 1.0
        or v.day_effect_pct is distinct from round(v.uplift_pct, 3));

\echo ''
\echo '=== 4. GUARD: reach can never exceed the list. ZERO rows expected. ==='
select name, stores_affected, stores_live
  from v_event_scope
 where stores_live > stores_affected;

\echo ''
\echo '=== 5. OPEN QUESTION, measured but NOT acted on ==='
\echo '    The +90% was anchored on the eve-to-normal-Friday ratio across all'
\echo '    38 stores. 18 of those are dark Coles. This recomputes that same'
\echo '    anchor on the 20 the engine can actually reach, for both seasons.'
\echo '    If the 20-only ratio is near 1.52x the rate transfers untouched.'
with scope as (
  select unnest(store_ids) as store_id from events where name = 'Rosh Hashanah - challah loaves'
),
prod as (
  select unnest(product_ids) as product_id from events where name = 'Rosh Hashanah - challah loaves'
),
as_of as (select coalesce(max(sale_date), current_date) as d from sales_daily),
live as (
  select distinct sd.store_id from sales_daily sd, as_of
   where sd.sale_date > as_of.d - 7 and sd.sale_date <= as_of.d
),
keep as (
  select sc.store_id from scope sc
    join stores s on s.id = sc.store_id and s.active
    join live l on l.store_id = sc.store_id
),
eves as (select * from (values (2024, date '2024-10-02'), (2025, date '2025-09-22')) v(yr, eve)),
-- The eve itself, on the 20.
eve_u as (
  select ev.yr, sum(sd.units_sold)::numeric as u
    from eves ev
    join sales_daily sd on sd.sale_date = ev.eve
    join keep k on k.store_id = sd.store_id
    join prod p on p.product_id = sd.product_id
   group by 1
),
-- A normal Friday: the three Fridays before the eve week, same 20 stores.
norm_fri as (
  select ev.yr, sum(sd.units_sold)::numeric / 3 as u
    from eves ev
    cross join generate_series(1,3) k(n)
    join sales_daily sd
      on sd.sale_date = (date_trunc('week', ev.eve)::date - 7 * k.n + 4)
    join keep kp on kp.store_id = sd.store_id
    join prod p  on p.product_id = sd.product_id
   group by 1
)
select e.yr                                     as season,
       round(e.u)                               as eve_units_20_stores,
       round(n.u)                               as normal_friday_20_stores,
       round(e.u / nullif(n.u, 0), 2)           as ratio_20_only,
       1.52                                     as ratio_all_38_used_for_the_90pct
  from eve_u e join norm_fri n on n.yr = e.yr
 order by 1;

\echo ''
\echo '=== 6. the 4.8x that started this, proven gone ==='
select case when exists (
         select 1 from v_event_scope v
          where v.start_date <= date '2026-09-13' and v.end_date >= date '2026-09-10'
          group by v.start_date having sum(v.day_effect_pct) > 50)
       then 'STILL WRONG - a Rosh Hashanah day still weights over +50%'
       else 'ok - no Rosh Hashanah day weights more than +50% now'
       end as verdict;

-- Undo — restores 036's view exactly:
--   create or replace view v_event_scope as
--   select e.id, e.name, e.start_date, e.end_date, e.uplift_pct, e.state,
--          case when e.store_ids is not null then cardinality(e.store_ids)
--               when e.store_id  is not null then 1
--               else (select count(*)::int from stores s
--                      where s.active and (e.state is null
--                        or e.state = (select r.state from regions r where r.id = s.region_id)))
--          end as stores_affected
--     from events e;
-- (create or replace cannot DROP columns, so the undo needs
--  `drop view v_event_scope;` first. Nothing else in the schema depends on it.)
