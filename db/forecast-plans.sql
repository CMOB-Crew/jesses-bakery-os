-- =====================================================================
-- Jesse's Bakery OS — forecasting engine as SQL (newsvendor / critical-fractile)
--
-- Populates replenishment_plans with the "suggested next order" per store x
-- product for the next delivery date. Mirrors services/forecast/app.py:
-- CR = 0.42 (pay-on-scan: waste expensive), z = inv_normal(0.42) = -0.2019,
-- target_stock = forecast_mean + z*std over the lead-time window, then
-- recommended = max(0, target - on_hand) hard-capped at shelf_max.
-- Run in the Supabase SQL editor any time to refresh the plans.
-- =====================================================================
delete from replenishment_plans;

with asof as (select max(sale_date) d from sales_daily),
tgt as (select (a.d + 1)::date as target_date, extract(dow from a.d + 1)::int as pgd from asof a),
stats as (
  select sd.store_id, sd.product_id,
         avg(sd.units_sold)::numeric              as mean_d,
         coalesce(stddev_samp(sd.units_sold),0)::numeric as std_d
  from sales_daily sd, tgt
  where extract(dow from sd.sale_date)::int = tgt.pgd
  group by sd.store_id, sd.product_id
),
oh as (
  select distinct on (store_id, product_id) store_id, product_id, closing_on_hand
  from on_hand_ledger
  order by store_id, product_id, as_of_date desc
),
calc as (
  select st.store_id, st.product_id, t.target_date,
         p.lead_time_days, p.min_on_shelf, s.shelf_max,
         round(st.mean_d * p.lead_time_days, 2) as forecast_demand,
         greatest(0, round(st.mean_d * p.lead_time_days + (-0.2019) * st.std_d * sqrt(p.lead_time_days)))::int as target_stock,
         coalesce(oh.closing_on_hand, 0) as on_hand
  from stats st
  join products p on p.id = st.product_id
  join stores   s on s.id = st.store_id
  cross join tgt t
  left join oh on oh.store_id = st.store_id and oh.product_id = st.product_id
),
final as (
  select *, greatest(0, target_stock - on_hand) as raw_rec from calc
)
insert into replenishment_plans
  (store_id, product_id, target_date, forecast_demand, target_stock,
   on_hand_estimate, recommended_qty, capped_by_shelf, reason, model_version)
select
  store_id, product_id, target_date, forecast_demand, target_stock, on_hand,
  case
    when raw_rec > coalesce(shelf_max, 1000000) then shelf_max
    when raw_rec > 0 and raw_rec < min_on_shelf then min_on_shelf
    else raw_rec
  end as recommended_qty,
  (raw_rec > coalesce(shelf_max, 1000000)) as capped_by_shelf,
  'Weekday demand ~' || round(forecast_demand / nullif(lead_time_days,0), 1) || '/day, '
    || lead_time_days || '-day cover. Target ' || target_stock
    || ' at the 42nd percentile (waste-aware), on hand ~' || on_hand
    || case when raw_rec > coalesce(shelf_max,1000000) then ' — capped at shelf max.' else '.' end,
  'newsvendor-sql-v1'
from final;

select count(*) as plans_written,
       count(*) filter (where capped_by_shelf) as capped,
       round(avg(recommended_qty),1) as avg_recommended
from replenishment_plans;
