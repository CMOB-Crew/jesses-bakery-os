-- =====================================================================
-- Migration 006: revenue layer (Invoice_Cost)
-- Additive and null-safe. Applying this changes NOTHING visible until the
-- joined Invoice_Cost extract is loaded into sales_daily.invoice_cost.
--
-- Invoice_Cost is what the retailer PAYS Jesse for the line = REVENUE,
-- not cost of goods. This unlocks revenue-weighted waste and revenue-
-- weighted priorities. True margin still needs Jesse's production cost
-- per unit (a separate Simona input), so keep the UI labelled "revenue".
--
-- Source: Fred's read-only joined extract (Option B) from the raw
-- reports (Coles_Report / Woolworths_Report / HarrisFarm_Report), where
-- Location -> Stores_Master.Supplier_Code and Sell_Item -> the retailer
-- product code. Confirmed by Fred: Waste_Qty is a dead end (all-zero,
-- 2024 only), so there is no reported-waste column to carry; inferred
-- waste (delivered - sold) stays the only method.
-- =====================================================================

-- Landing spot for the extract: retailer-paid line revenue, same grain
-- and key as sales_daily (store x product x day). NULL until loaded.
alter table sales_daily
  add column if not exists invoice_cost numeric(12,4);

comment on column sales_daily.invoice_cost is
  'Retailer-paid line revenue for this store/product/day (Invoice_Cost from the joined extract). Revenue, NOT margin. NULL until the extract is loaded.';

-- Per store x product average unit revenue over the trailing 7 days.
-- unit_revenue = revenue / units — the building block for valuing waste
-- and opportunities in dollars. Empty until invoice_cost is populated,
-- so every downstream reader degrades gracefully to units-only today.
create or replace view v_unit_revenue as
  with a as (select as_of from v_asof)
  select
    s.store_id,
    s.product_id,
    sum(s.invoice_cost)                                          as revenue,
    sum(s.units_sold)::int                                       as units,
    round(sum(s.invoice_cost) / nullif(sum(s.units_sold), 0), 4) as unit_revenue
  from sales_daily s, a
  where s.sale_date >  a.as_of - interval '7 days'
    and s.sale_date <= a.as_of
    and s.invoice_cost is not null
  group by s.store_id, s.product_id;

-- Store-level revenue + revenue-weighted waste for the trailing week.
-- waste_revenue = wasted units valued at each product's unit revenue
-- (store waste falls back to inferred sent - sold at the store level;
-- this per-product valuation is the dollar overlay for the waste views).
-- Returns nothing until invoice_cost is populated.
create or replace view v_store_revenue_week as
  with a as (select as_of from v_asof),
  rev as (
    select s.store_id,
           sum(s.invoice_cost)                                        as revenue_wk,
           round(sum(s.invoice_cost) / nullif(sum(s.units_sold),0),4) as avg_unit_revenue
    from sales_daily s, a
    where s.sale_date >  a.as_of - interval '7 days'
      and s.sale_date <= a.as_of
      and s.invoice_cost is not null
    group by s.store_id
  ),
  waste_val as (
    select w.store_id,
           sum(w.qty * coalesce(ur.unit_revenue, 0))                  as waste_revenue_wk
    from wastage w
    cross join a
    left join v_unit_revenue ur
      on ur.store_id = w.store_id and ur.product_id = w.product_id
    where w.waste_date >  a.as_of - interval '7 days'
      and w.waste_date <= a.as_of
    group by w.store_id
  )
  select r.store_id, r.revenue_wk, r.avg_unit_revenue,
         coalesce(wv.waste_revenue_wk, 0) as waste_revenue_wk
  from rev r
  left join waste_val wv on wv.store_id = r.store_id;
