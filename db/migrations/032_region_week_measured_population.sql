-- 032 — the region rollup has the same denominator bug 031 fixed at network level
--
-- v_region_week divides waste (which is NULL for every store with no sales feed,
-- per migration 027, and so sums away) by total_sent (which counts those stores'
-- deliveries in full). Every region tile on the Overview therefore understates
-- its waste by exactly the share of its stores that are dark — which today, with
-- the Coles feed down since 3 Aug, is most of them in most regions.
--
-- Same shape as 031, so the two rollups agree with each other and with the store
-- pages underneath them. `green` also gets a measured twin: a dark store scores
-- green today only because there is nothing to fail it on.
--
-- total_sent / total_sold / total_wasted keep their current meaning (everything
-- delivered in the region) so nothing that reads them silently shifts.
--
-- Idempotent: create or replace, new columns appended at the end.

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
  -- Numerator and denominator from the same stores.
  round(
    100.0 * sum(total_wasted) filter (where has_sales_feed)
    / nullif(sum(total_sent) filter (where has_sales_feed), 0)
  , 1)                                                as waste_pct,
  count(*) filter (where has_sales_feed)::int         as feed_stores,
  coalesce(sum(total_sent) filter (where has_sales_feed), 0)::int as feed_sent,
  coalesce(sum(total_sold) filter (where has_sales_feed), 0)::int as feed_sold
from v_store_week
group by region_id, region;

alter view v_region_week set (security_invoker = on);
