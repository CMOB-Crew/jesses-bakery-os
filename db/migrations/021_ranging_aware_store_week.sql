-- Migration 021: make v_store_week ranging-aware.
-- Source: Session 2 UAT (21 Aug 2026). Simona: stores look like underperformers
--   because products NOT ranged to them are still counted as "sent but unsold."
--   Her example: Mascot DC is actually strong once you drop what it never
--   receives. The Adjust / un-range toggle already persists to
--   store_product_ranging (migration 015) but ONLY affected the recommendation;
--   the headline waste %, sell-through and RAG status still summed every product.
--
-- This recreates v_store_week so the sent / sold / wasted CTEs exclude any
-- (store, product) explicitly marked ranged = false. Absence of a row = ranged
-- (the default), so a store with no overrides is completely unchanged. Only
-- stores that have an explicit un-range drop those lines from their totals.
-- That makes the un-range toggle finally move the waste number, exactly as she
-- expects, and lets us load the 14 Aug ranging variances to fix the numbers.
--
-- Column list, order and types are IDENTICAL to migration 002 — create or
-- replace requires that. Only the three CTEs gained a ranging filter. NB the
-- `, a` (the as_of cross join) sits AFTER each left join so `s`/`d`/`w` stay in
-- scope for the join's ON clause. Re-assert security_invoker at the end
-- (migration 013) since we recreate the view. Idempotent: create or replace.

create or replace view v_store_week as
with a as (select as_of from v_asof),
sold as (
  select s.store_id, sum(s.units_sold)::int total_sold
  from sales_daily s
  left join store_product_ranging r
    on r.store_id = s.store_id and r.product_id = s.product_id, a
  where s.sale_date >  a.as_of - interval '7 days'
    and s.sale_date <= a.as_of
    and coalesce(r.ranged, true)
  group by s.store_id
),
sold_prev as (
  select s.store_id, sum(s.units_sold)::int total_sold_prev
  from sales_daily s
  left join store_product_ranging r
    on r.store_id = s.store_id and r.product_id = s.product_id, a
  where s.sale_date >  a.as_of - interval '14 days'
    and s.sale_date <= a.as_of - interval '7 days'
    and coalesce(r.ranged, true)
  group by s.store_id
),
sent as (
  select d.store_id, sum(di.qty_sent)::int total_sent
  from deliveries d
  join delivery_items di on di.delivery_id = d.id
  left join store_product_ranging r
    on r.store_id = d.store_id and r.product_id = di.product_id, a
  where d.delivery_date >  a.as_of - interval '7 days'
    and d.delivery_date <= a.as_of
    and coalesce(r.ranged, true)
  group by d.store_id
),
waste as (
  select w.store_id, sum(w.qty)::int total_wasted
  from wastage w
  left join store_product_ranging r
    on r.store_id = w.store_id and r.product_id = w.product_id, a
  where w.waste_date >  a.as_of - interval '7 days'
    and w.waste_date <= a.as_of
    and coalesce(r.ranged, true)
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

-- Recreating the view can drop the invoker setting (migration 013); re-assert it.
alter view v_store_week set (security_invoker = on);
