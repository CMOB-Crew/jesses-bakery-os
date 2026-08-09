-- =====================================================================
-- Migration 002: reporting views
-- These encapsulate the waste / status / trend logic so the app reads
-- simple rows. Everything is anchored to v_asof (the latest data date),
-- so the dashboard's "this week" tracks the freshest feed, not the wall
-- clock. Waste source of truth is the wastage table (driver-captured);
-- it falls back to inferred (sent - sold) when a store has no capture yet.
-- =====================================================================

-- Latest date we have sales for — the app's "as of".
create or replace view v_asof as
  select coalesce(max(sale_date), current_date) as as_of from sales_daily;

-- Status thresholds, centralised so the app never hardcodes them.
-- red:   waste > 30%  OR  >= 3 stockout days
-- amber: waste >= 20% OR  >= 1 stockout day
-- green: otherwise
create or replace function jb_status(waste_pct numeric, stockout_days int)
returns text language sql immutable as $$
  select case
    when waste_pct > 30 or stockout_days >= 3 then 'red'
    when waste_pct >= 20 or stockout_days >= 1 then 'amber'
    else 'green' end
$$;

-- ---------------------------------------------------------------------
-- Per-store, trailing 7 days ending at as_of
-- ---------------------------------------------------------------------
create or replace view v_store_week as
with a as (select as_of from v_asof),
sold as (
  select s.store_id, sum(s.units_sold)::int total_sold
  from sales_daily s, a
  where s.sale_date >  a.as_of - interval '7 days'
    and s.sale_date <= a.as_of
  group by s.store_id
),
sold_prev as (
  select s.store_id, sum(s.units_sold)::int total_sold_prev
  from sales_daily s, a
  where s.sale_date >  a.as_of - interval '14 days'
    and s.sale_date <= a.as_of - interval '7 days'
  group by s.store_id
),
sent as (
  select d.store_id, sum(di.qty_sent)::int total_sent
  from deliveries d
  join delivery_items di on di.delivery_id = d.id, a
  where d.delivery_date >  a.as_of - interval '7 days'
    and d.delivery_date <= a.as_of
  group by d.store_id
),
waste as (
  select w.store_id, sum(w.qty)::int total_wasted
  from wastage w, a
  where w.waste_date >  a.as_of - interval '7 days'
    and w.waste_date <= a.as_of
  group by w.store_id
),
stk as (
  -- a stockout day = shelf hit zero with nothing left to expire; if stock
  -- was left over to expire, the store didn't run out.
  select l.store_id,
         count(*) filter (where l.closing_on_hand = 0 and l.expired = 0)::int stockout_days
  from on_hand_ledger l, a
  where l.as_of_date >  a.as_of - interval '7 days'
    and l.as_of_date <= a.as_of
  group by l.store_id
)
select
  st.id                                        as store_id,
  st.name,
  st.retailer,
  st.size_category,
  st.shelf_max,
  st.region_id,
  reg.name                                     as region,
  coalesce(sent.total_sent, 0)                 as total_sent,
  coalesce(sold.total_sold, 0)                 as total_sold,
  coalesce(sold_prev.total_sold_prev, 0)       as total_sold_prev,
  coalesce(
    waste.total_wasted,
    greatest(coalesce(sent.total_sent,0) - coalesce(sold.total_sold,0), 0)
  )                                            as total_wasted,
  coalesce(stk.stockout_days, 0)               as stockout_days,
  round(
    100.0 * coalesce(
      waste.total_wasted,
      greatest(coalesce(sent.total_sent,0) - coalesce(sold.total_sold,0), 0)
    ) / nullif(coalesce(sent.total_sent,0), 0)
  , 1)                                         as waste_pct,
  jb_status(
    round(
      100.0 * coalesce(
        waste.total_wasted,
        greatest(coalesce(sent.total_sent,0) - coalesce(sold.total_sold,0), 0)
      ) / nullif(coalesce(sent.total_sent,0), 0)
    , 1),
    coalesce(stk.stockout_days, 0)
  )                                            as status
from stores st
left join regions reg on reg.id = st.region_id
left join sold      on sold.store_id      = st.id
left join sold_prev on sold_prev.store_id = st.id
left join sent      on sent.store_id      = st.id
left join waste     on waste.store_id     = st.id
left join stk       on stk.store_id       = st.id
where st.active;

-- ---------------------------------------------------------------------
-- Per-region rollup
-- ---------------------------------------------------------------------
create or replace view v_region_week as
select
  region_id,
  region,
  count(*)                                            as stores,
  count(*) filter (where status = 'red')::int         as red,
  count(*) filter (where status = 'amber')::int       as amber,
  count(*) filter (where status = 'green')::int       as green,
  sum(total_sent)::int                                as total_sent,
  sum(total_sold)::int                                as total_sold,
  sum(total_wasted)::int                              as total_wasted,
  round(100.0 * sum(total_wasted) / nullif(sum(total_sent),0), 1) as waste_pct
from v_store_week
group by region_id, region;

-- ---------------------------------------------------------------------
-- Network single-row summary
-- ---------------------------------------------------------------------
create or replace view v_network_week as
select
  count(*)                                        as stores,
  count(*) filter (where status='red')::int       as red,
  count(*) filter (where status='amber')::int     as amber,
  count(*) filter (where status='green')::int     as green,
  sum(total_sent)::int                            as total_sent,
  sum(total_sold)::int                            as total_sold,
  sum(total_wasted)::int                          as total_wasted,
  round(100.0 * sum(total_wasted) / nullif(sum(total_sent),0), 1) as waste_pct
from v_store_week;

-- ---------------------------------------------------------------------
-- 6-week network waste trend (feeds the signature chart)
-- wk 0 = most recent 7-day window, wk 5 = oldest.
-- ---------------------------------------------------------------------
create or replace view v_waste_trend as
with a as (select as_of from v_asof)
select
  g.wk,
  (select coalesce(sum(di.qty_sent),0)
     from deliveries d join delivery_items di on di.delivery_id = d.id, a
    where d.delivery_date >  a.as_of - ((g.wk+1)*7) * interval '1 day'
      and d.delivery_date <= a.as_of - (g.wk*7) * interval '1 day')::int as sent,
  (select coalesce(sum(w.qty),0)
     from wastage w, a
    where w.waste_date >  a.as_of - ((g.wk+1)*7) * interval '1 day'
      and w.waste_date <= a.as_of - (g.wk*7) * interval '1 day')::int as wasted
from generate_series(0,5) as g(wk), a;

-- ---------------------------------------------------------------------
-- Per-store daily units this week (for the store-detail bars)
-- ---------------------------------------------------------------------
create or replace view v_store_daily as
with a as (select as_of from v_asof)
select
  d.store_id,
  d.sale_date,
  to_char(d.sale_date, 'Dy')      as dow,
  d.units_sold::int               as sold,
  coalesce(sent.qty_sent, 0)::int as sent
from (
  select s.store_id, s.sale_date, sum(s.units_sold) units_sold
  from sales_daily s, a
  where s.sale_date > a.as_of - interval '7 days' and s.sale_date <= a.as_of
  group by s.store_id, s.sale_date
) d
left join (
  select dl.store_id, dl.delivery_date, sum(di.qty_sent) qty_sent
  from deliveries dl join delivery_items di on di.delivery_id = dl.id, a
  where dl.delivery_date > a.as_of - interval '7 days' and dl.delivery_date <= a.as_of
  group by dl.store_id, dl.delivery_date
) sent on sent.store_id = d.store_id and sent.delivery_date = d.sale_date;
