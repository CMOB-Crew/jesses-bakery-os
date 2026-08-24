-- Migration 027: a store either reports sales back to us, or it doesn't
--
-- Found 24 Aug 2026 while reconciling the legacy inventory ledger. The ledger's
-- one week of real deliveries implied 70% waste. It isn't:
--
--   everything                  43,062 delivered   12,743 sold   70.4%
--   scan-reporting stores only  19,491 delivered   12,743 sold   34.6%   <- Jesse's known figure is 32.5%
--   non-scan stores only        23,571 delivered        0 sold  100.0%
--
-- 155 of the 249 stores in that week are invoice customers. Jesse delivers to
-- them and invoices them; they never report a scan sale. Only Woolworths, Coles
-- and Harris Farm feed sales data back. Put those 155 in the denominator and
-- every unit delivered looks like waste.
--
-- So: waste is not LOW for an invoice customer, and it is certainly not 100%.
-- It is UNKNOWABLE. The view now says so -- waste_pct and total_wasted come back
-- NULL for any store with no sales feed, and has_sales_feed says which is which.
--
-- Same shape as Simona's un-ranged-products problem (an unranged SKU reads zero
-- sales, which is correct, not a stockout) one level up: a real number computed
-- over the wrong denominator is worse than no number.
--
-- Without this, loading the delivery data would put 155 stores on the Stores
-- list at 100% waste, flagged red. That is why this lands BEFORE the load.
--
-- has_sales_feed is derived from sales_daily rather than stores.retailer, so a
-- miscategorised store cannot slip through.
--
-- Idempotent: create or replace. Safe to run more than once.

create or replace view v_store_week as
with a as (select as_of from v_asof),
-- Is this store's sales feed REPORTING, in the same window everything else on
-- this view uses? Not "did it ever report" — that is too loose. The Coles feed
-- stopped on 3 Aug 2026 (report format change). Those stores have two years of
-- history and are still being delivered to, so an "ever" test counts them as
-- reporting and every unit delivered since reads as waste: 64.8% network-wide
-- instead of the real 34.6%.
--
-- We cannot tell "sold nothing" from "feed stopped reporting", and defaulting to
-- 100% waste is the dangerous half of that. So: no sales in the window means
-- waste is unknowable, and the store reads no-data.
feed as (
  select distinct sd.store_id
  from sales_daily sd, a
  where sd.sale_date >  a.as_of - interval '7 days'
    and sd.sale_date <= a.as_of
),
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
  case when f.store_id is null then null else coalesce(
    waste.total_wasted,
    greatest(coalesce(sent.total_sent,0) - coalesce(sold.total_sold,0), 0)
  ) end                                        as total_wasted,
  coalesce(stk.stockout_days, 0)               as stockout_days,
  case when f.store_id is null then null else round(
    100.0 * coalesce(
      waste.total_wasted,
      greatest(coalesce(sent.total_sent,0) - coalesce(sold.total_sold,0), 0)
    ) / nullif(coalesce(sent.total_sent,0), 0)
  , 1) end                                     as waste_pct,
  case when f.store_id is null then 'green' else jb_status(
    round(
      100.0 * coalesce(
        waste.total_wasted,
        greatest(coalesce(sent.total_sent,0) - coalesce(sold.total_sold,0), 0)
      ) / nullif(coalesce(sent.total_sent,0), 0)
    , 1),
    coalesce(stk.stockout_days, 0)
  ) end                                        as status,
  -- Appended last on purpose: `create or replace view` can only ADD columns at
  -- the end, never insert one mid-list.
  (f.store_id is not null)                     as has_sales_feed
from stores st
left join regions reg on reg.id = st.region_id
left join sold      on sold.store_id      = st.id
left join sold_prev on sold_prev.store_id = st.id
left join sent      on sent.store_id      = st.id
left join waste     on waste.store_id     = st.id
left join stk       on stk.store_id       = st.id
left join feed      f  on f.store_id        = st.id
where st.active;
