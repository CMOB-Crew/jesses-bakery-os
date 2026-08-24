-- ============================================================
-- Forecast engine — SET-BASED port of services/forecast/app.py
-- DRY RUN. Writes NOTHING. Run as the privileged postgres connection.
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
--   z              -0.19920132478926697  = NormalDist().inv_cdf(0.4210526...)
--                  critical ratio = 0.40 / (0.40 + 0.55), pay-on-scan:
--                  a wasted loaf costs the whole unit, a stockout only margin.
--                  z is NEGATIVE on purpose — it stocks BELOW the mean.
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
         -0.19920132478926697::numeric                    as z
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
         reg.state
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
         greatest(1, c.lead_time_days)                               as coverage,
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
\echo '--- per product ---'
-- ============================================================
-- Forecast engine — SET-BASED port of services/forecast/app.py
-- DRY RUN. Writes NOTHING. Run as the privileged postgres connection.
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
--   z              -0.19920132478926697  = NormalDist().inv_cdf(0.4210526...)
--                  critical ratio = 0.40 / (0.40 + 0.55), pay-on-scan:
--                  a wasted loaf costs the whole unit, a stockout only margin.
--                  z is NEGATIVE on purpose — it stocks BELOW the mean.
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
         -0.19920132478926697::numeric                    as z
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
         reg.state
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
         greatest(1, c.lead_time_days)                               as coverage,
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
