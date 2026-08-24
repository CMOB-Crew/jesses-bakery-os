-- ============================================================
-- Forecast engine — SET-BASED port of services/forecast/app.py
-- DRY RUN v3 — coverage capped at shelf life — coverage = days until the store's next delivery. Writes NOTHING. Run as the privileged postgres connection.
--
-- Why a port: app.py loops per store x product, firing two queries each.
-- 265 stores x 116 products is ~30k combos / ~60k round trips. It was written
-- against a local database (127.0.0.1:5433); against Supabase in Singapore that
-- is hours. This runs the identical arithmetic server-side, in one pass.
--
-- The maths is app.py's, unchanged:
--   weekday_stats  mean/std of units_sold for the target weekday, last 6
--                  occurrences. Population std (/n, matching Python). Single
--                  observation -> std = mean * 0.25, as app.py does.
--   coverage       max(1, products.lead_time_days)
--   uplift         sum(events.uplift_pct) for the target date, national or
--                  matching the store's state
--   f_mean         mean * coverage * (1 + uplift)
--   f_std          std * sqrt(coverage)
--   target_stock   max(0, round(f_mean + z * f_std))
--   z              service level, settable with -v z=... (default +0.201893)
--                  critical ratio = 0.40 / (0.40 + 0.55), pay-on-scan:
--                  a wasted loaf costs the whole unit, a stockout only margin.
--                  SIGN MATTERS: negative z stocks below mean demand, positive
--                  above. It was -0.199 (42nd percentile) from a margin WE
--                  assumed; it is now +0.28, set from Simona's stated 20-25%
--                  waste band. See the SERVICE LEVEL block at the top.
--   on_hand        latest on_hand_ledger.closing_on_hand, else 0
--   recommended    max(0, target_stock - on_hand), capped at shelf_max,
--                  floored at min_on_shelf when non-zero
-- ============================================================
-- SERVICE LEVEL (z) -- the dial that decides how hard this trims.
--
-- Was hardcoded at -0.19920132478926697 = inv_cdf(0.40 / (0.40 + 0.55)), the
-- 42nd percentile. That critical ratio was OUR assumption about Jesse's margins,
-- never his. Negative z stocks BELOW the mean, i.e. runs short about half the
-- time, and on the real data it produced 9.4% waste.
--
-- Simona has stated the answer twice and it is not a margin, it is an outcome:
--   6 Aug factory walkthrough : "under 20% wastage = too low, store needs more"
--   12 Aug production session : "wastage can sit ~20%, acceptable range 20-25%"
--
-- 9.4% is less than half her floor. Default is now +0.201893 = inv_cdf(0.58),
-- which lands ~22.5% waste on a ~15% trim -- inside her band, clear of her
-- floor, and matching the 22.5% the dashboard panel already promises.
--
-- Override per run:  -v z=0.35   (higher = fuller shelves, more waste)
\if :{?z}
\else
  \set z 0.201893
\endif

\timing on

with params as (
  select (select coalesce(max(sale_date), current_date) from sales_daily) as as_of
),
p2 as (
  select as_of,
         :'target'::date                                  as target_date,
         extract(dow from :'target'::date)::int           as pg_dow,
         :z::numeric                                      as z
  from params
),
-- The last 6 CALENDAR occurrences of the target weekday.
--
-- This used to take the last 6 ROWS from sales_daily matching the weekday. That
-- is not the same thing, and the difference was costing real money:
--
--   sales_daily only holds rows for days something SOLD -- the retailers report
--   sales, not zeros. Taking the last 6 rows therefore averaged over only the
--   days that HAD a sale and silently dropped every zero day. Across live stores
--   the mean came out 1.49x true demand (2.802 vs 1.886 on Sundays). For fast
--   lines that sell daily it barely mattered; for slow lines it was brutal.
--   Harris Farm Rose Bay sold ZERO raisin challah on all six recent Sundays, and
--   the engine still forecast 6.33 -- because with no recency bound it reached
--   back months to find six Sundays that did have sales.
--
-- Building the calendar first and left-joining fixes both faults at once: the
-- zero days are present and counted, and the window cannot slide into ancient
-- history. n is now always 6, so the old "single observation -> std = mean*0.25"
-- branch never fires; with six real observations stddev_pop is meaningful.
cal as (
  select (p2.target_date - (7 * g.n))::date as d
  from p2, generate_series(1, 6) g(n)
),
-- Only plan pairs that are actually ranged here: anything that sold at this
-- store in the six weeks to as_of. No sale in six weeks means delisted or never
-- ranged, and a zero-filled grid would otherwise invent a plan for it.
pairs as (
  select distinct sd.store_id, sd.product_id
  from sales_daily sd, p2
  where sd.sale_date > p2.as_of - 42 and sd.sale_date <= p2.as_of
),
grid as (
  select pr.store_id, pr.product_id, cal.d,
         coalesce(sd.units_sold, 0)::numeric as units
  from pairs pr
  cross join cal
  left join sales_daily sd
    on sd.store_id  = pr.store_id
   and sd.product_id = pr.product_id
   and sd.sale_date  = cal.d
),
stats as (
  select store_id, product_id,
         count(*)                    as n,
         avg(units)::numeric         as mean,
         stddev_pop(units)::numeric  as std_pop
  from grid
  group by store_id, product_id
),
combos as (
  select st.id  as store_id,
         p.id   as product_id,
         st.shelf_max,
         p.lead_time_days,
         p.min_on_shelf,
         reg.state,
         -- Days of stock this drop has to cover: how long until this store's
         -- NEXT delivery. app.py used products.lead_time_days, which is a bake
         -- offset, not a coverage window — so a store delivered Thu + Sat was
         -- being sent one day of stock to last two.
         -- ...but never more days than the bread stays good for. 23 active
         -- stores take one delivery a week; sending them 7 days of stock when
         -- shelf life is 5 would manufacture the exact waste this engine
         -- exists to remove. Those stores are structurally under-served — the
         -- honest answer is to fill to shelf life and flag the gap, not to
         -- pretend a week's bread survives a week.
         least(
           coalesce((select min(g.n) from generate_series(1,7) g(n)
                      where trim(to_char(p2.target_date + g.n, 'dy'))::weekday
                            = any(st.delivery_days)), 1),
           greatest(1, p.shelf_life_days)
         ) as cover_days
  from stores st
  cross join products p
  cross join p2
  left join regions reg on reg.id = st.region_id
  -- Only plan a store for a day it actually receives a delivery. Without this
  -- the engine recommends for every store every day, which roughly doubles the
  -- plan against Jesse's real sheet. (migration 026)
  where st.active and p.active
    and trim(to_char(p2.target_date, 'dy'))::weekday = any(st.delivery_days)
    -- Only plan a store whose feed is still alive. Same seven-day test migration
    -- 027 uses for the dashboard, so "live" means one thing across the system.
    -- Without it the engine sizes the 110 Coles stores -- dead since 8 Aug --
    -- off stale history and asks for 24% MORE than they currently receive, on
    -- zero recorded sales.
    and exists (select 1 from sales_daily sd
                where sd.store_id = st.id
                  and sd.sale_date >  p2.as_of - 7
                  and sd.sale_date <= p2.as_of)
),
uplift as (
  select c.store_id, c.product_id,
         coalesce((select sum(e.uplift_pct) from events e, p2
                    where p2.target_date between e.start_date and e.end_date
                      and (e.state is null or e.state = c.state::text)), 0)::numeric / 100.0 as up
  from combos c
),
onhand as (
  select distinct on (store_id, product_id) store_id, product_id, closing_on_hand
  from on_hand_ledger
  order by store_id, product_id, as_of_date desc
),
calc as (
  select c.store_id, c.product_id, p2.target_date,
         st.mean, st.n,
         -- app.py: one observation -> std = mean * 0.25
         case when st.n <= 1 then st.mean * 0.25 else st.std_pop end as std,
         greatest(1, c.cover_days)                                   as coverage,
         u.up, coalesce(oh.closing_on_hand, 0)                       as on_hand,
         c.shelf_max, c.min_on_shelf, p2.z
  from combos c
  join stats st on st.store_id = c.store_id and st.product_id = c.product_id
  join uplift u on u.store_id = c.store_id and u.product_id = c.product_id
  left join onhand oh on oh.store_id = c.store_id and oh.product_id = c.product_id
  cross join p2
),
final as (
  select store_id, product_id, target_date, mean, on_hand, shelf_max, min_on_shelf,
         round(mean * coverage * (1 + up), 2)                                  as forecast_demand,
         greatest(0, round(mean * coverage * (1 + up) + z * (std * sqrt(coverage))))::int as target_stock
  from calc
),
capped as (
  select f.*,
         greatest(0, f.target_stock - f.on_hand) as raw_rec
  from final f
),
result as (
  select c.*,
         case
           when c.shelf_max is not null and c.raw_rec > c.shelf_max then c.shelf_max
           when c.raw_rec > 0 and c.raw_rec < c.min_on_shelf        then c.min_on_shelf
           else c.raw_rec
         end                                                              as recommended_qty,
         (c.shelf_max is not null and c.raw_rec > c.shelf_max)            as capped_by_shelf
  from capped c
)
select
  (select target_date from p2)                                as target_date,
  trim(to_char((select target_date from p2), 'Day'))          as weekday,
  (select count(*) from stores st, p2
     where st.active
       and trim(to_char(p2.target_date,'dy'))::weekday = any(st.delivery_days))
                                                              as stores_delivered_today,
  count(*)                                                    as plans,
  count(distinct store_id)                                    as stores_planned,
  count(distinct product_id)                                  as products,
  sum(recommended_qty)                                        as total_units,
  count(*) filter (where capped_by_shelf)                     as capped_at_shelf_max,
  round(avg(recommended_qty), 2)                              as avg_reco
from result;

\echo ''
\echo '--- stores where the delivery gap exceeds shelf life (structurally under-served) ---'
select coalesce(array_length(st.delivery_days,1),0) as deliveries_per_week,
       count(*) as stores
from stores st
where st.active and coalesce(array_length(st.delivery_days,1),0) between 1 and 2
group by 1 order by 1;

\echo ''
\echo '--- how often each active store is delivered ---'
select coalesce(array_length(delivery_days, 1), 0) as deliveries_per_week,
       count(*) as stores
from stores where active
group by 1 order by 1;

\echo ''
\echo '--- per product ---'
-- ============================================================
-- Forecast engine — SET-BASED port of services/forecast/app.py
-- DRY RUN v3 — coverage capped at shelf life — coverage = days until the store's next delivery. Writes NOTHING. Run as the privileged postgres connection.
--
-- Why a port: app.py loops per store x product, firing two queries each.
-- 265 stores x 116 products is ~30k combos / ~60k round trips. It was written
-- against a local database (127.0.0.1:5433); against Supabase in Singapore that
-- is hours. This runs the identical arithmetic server-side, in one pass.
--
-- The maths is app.py's, unchanged:
--   weekday_stats  mean/std of units_sold for the target weekday, last 6
--                  occurrences. Population std (/n, matching Python). Single
--                  observation -> std = mean * 0.25, as app.py does.
--   coverage       max(1, products.lead_time_days)
--   uplift         sum(events.uplift_pct) for the target date, national or
--                  matching the store's state
--   f_mean         mean * coverage * (1 + uplift)
--   f_std          std * sqrt(coverage)
--   target_stock   max(0, round(f_mean + z * f_std))
--   z              service level, settable with -v z=... (default +0.201893)
--                  critical ratio = 0.40 / (0.40 + 0.55), pay-on-scan:
--                  a wasted loaf costs the whole unit, a stockout only margin.
--                  SIGN MATTERS: negative z stocks below mean demand, positive
--                  above. It was -0.199 (42nd percentile) from a margin WE
--                  assumed; it is now +0.28, set from Simona's stated 20-25%
--                  waste band. See the SERVICE LEVEL block at the top.
--   on_hand        latest on_hand_ledger.closing_on_hand, else 0
--   recommended    max(0, target_stock - on_hand), capped at shelf_max,
--                  floored at min_on_shelf when non-zero
-- ============================================================
\timing on

with params as (
  select (select coalesce(max(sale_date), current_date) from sales_daily) as as_of
),
p2 as (
  select as_of,
         :'target'::date                                  as target_date,
         extract(dow from :'target'::date)::int           as pg_dow,
         :z::numeric                                      as z
  from params
),
-- last 6 occurrences of the target weekday, per store x product
recent as (
  select s.store_id, s.product_id, s.units_sold,
         row_number() over (partition by s.store_id, s.product_id
                            order by s.sale_date desc) as rn
  from sales_daily s, p2
  where extract(dow from s.sale_date)::int = p2.pg_dow
),
stats as (
  select store_id, product_id,
         count(*)                          as n,
         avg(units_sold)::numeric          as mean,
         stddev_pop(units_sold)::numeric   as std_pop
  from recent
  where rn <= 6
  group by store_id, product_id
),
combos as (
  select st.id  as store_id,
         p.id   as product_id,
         st.shelf_max,
         p.lead_time_days,
         p.min_on_shelf,
         reg.state,
         -- Days of stock this drop has to cover: how long until this store's
         -- NEXT delivery. app.py used products.lead_time_days, which is a bake
         -- offset, not a coverage window — so a store delivered Thu + Sat was
         -- being sent one day of stock to last two.
         -- ...but never more days than the bread stays good for. 23 active
         -- stores take one delivery a week; sending them 7 days of stock when
         -- shelf life is 5 would manufacture the exact waste this engine
         -- exists to remove. Those stores are structurally under-served — the
         -- honest answer is to fill to shelf life and flag the gap, not to
         -- pretend a week's bread survives a week.
         least(
           coalesce((select min(g.n) from generate_series(1,7) g(n)
                      where trim(to_char(p2.target_date + g.n, 'dy'))::weekday
                            = any(st.delivery_days)), 1),
           greatest(1, p.shelf_life_days)
         ) as cover_days
  from stores st
  cross join products p
  cross join p2
  left join regions reg on reg.id = st.region_id
  -- Only plan a store for a day it actually receives a delivery. Without this
  -- the engine recommends for every store every day, which roughly doubles the
  -- plan against Jesse's real sheet. (migration 026)
  where st.active and p.active
    and trim(to_char(p2.target_date, 'dy'))::weekday = any(st.delivery_days)
),
uplift as (
  select c.store_id, c.product_id,
         coalesce((select sum(e.uplift_pct) from events e, p2
                    where p2.target_date between e.start_date and e.end_date
                      and (e.state is null or e.state = c.state::text)), 0)::numeric / 100.0 as up
  from combos c
),
onhand as (
  select distinct on (store_id, product_id) store_id, product_id, closing_on_hand
  from on_hand_ledger
  order by store_id, product_id, as_of_date desc
),
calc as (
  select c.store_id, c.product_id, p2.target_date,
         st.mean, st.n,
         -- app.py: one observation -> std = mean * 0.25
         case when st.n <= 1 then st.mean * 0.25 else st.std_pop end as std,
         greatest(1, c.cover_days)                                   as coverage,
         u.up, coalesce(oh.closing_on_hand, 0)                       as on_hand,
         c.shelf_max, c.min_on_shelf, p2.z
  from combos c
  join stats st on st.store_id = c.store_id and st.product_id = c.product_id
  join uplift u on u.store_id = c.store_id and u.product_id = c.product_id
  left join onhand oh on oh.store_id = c.store_id and oh.product_id = c.product_id
  cross join p2
),
final as (
  select store_id, product_id, target_date, mean, on_hand, shelf_max, min_on_shelf,
         round(mean * coverage * (1 + up), 2)                                  as forecast_demand,
         greatest(0, round(mean * coverage * (1 + up) + z * (std * sqrt(coverage))))::int as target_stock
  from calc
),
capped as (
  select f.*,
         greatest(0, f.target_stock - f.on_hand) as raw_rec
  from final f
),
result as (
  select c.*,
         case
           when c.shelf_max is not null and c.raw_rec > c.shelf_max then c.shelf_max
           when c.raw_rec > 0 and c.raw_rec < c.min_on_shelf        then c.min_on_shelf
           else c.raw_rec
         end                                                              as recommended_qty,
         (c.shelf_max is not null and c.raw_rec > c.shelf_max)            as capped_by_shelf
  from capped c
)select p.name                           as product,
       count(*)                         as store_lines,
       sum(r.recommended_qty)           as units
from result r
join products p on p.id = r.product_id
group by p.name
order by units desc;
