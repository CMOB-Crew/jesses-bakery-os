-- 090_currently_sending_was_a_standing_order.sql
--
-- WHAT THIS FIXES, AND WHAT IT DELIBERATELY DOES NOT TOUCH
--
-- Every delivery and production screen compares the engine's recommendation
-- against store_reco.sent and calls it "currently sending". Nothing has ever
-- written store_reco.sent. It was seeded once by the legacy load and has sat
-- there since, so the recommendation moves nightly and the number it is
-- measured against does not.
--
-- The obvious repair -- write sent from what we actually delivered -- is a
-- trap, and it took reading the packing query to see it. store_reco.sent is
-- ALSO the packing sheet's fallback: any store due a delivery that has no plan
-- for the day is packed at its store_reco.sent (lib/queries.ts, the `standing`
-- CTE), including what the comment there calls "4,369 units a week, the
-- largest standing order in the business". Overwriting it on 10 September,
-- with two days of driver records in the system, would have packed those
-- stores at zero.
--
-- So store_reco.sent is not a stale measurement. It is the STANDING ORDER,
-- under a name that says something else. It stays exactly as it is.
--
-- (There is a standing_orders table in 001_init that nothing has ever read or
-- written. It is the fifth table found in this system that the schema promises
-- and nothing fills. Not touched here; noted so the next person does not
-- assume it holds anything.)
--
-- WHAT THIS ADDS
--
-- The measured number, as a view rather than a column. No nightly write, so
-- there is no new job to stop silently and nothing to go stale between runs --
-- the failure mode this table has already demonstrated once.
--
-- The window and the ranging filter are copied from v_store_week's `sent` CTE
-- deliberately, so a per-product roll-up of this view equals that view's
-- total_sent for the same store. They agree by construction rather than by
-- two people writing the same seven days twice.
--
-- Idempotent. Safe to run more than once.

create or replace view v_store_product_delivered as
select d.store_id,
       di.product_id,
       sum(di.qty_sent)::int                        as delivered,
       sum(coalesce(di.qty_delivered, di.qty_sent))::int as received,
       count(distinct d.delivery_date)::int         as drops,
       max(d.delivery_date)                         as last_delivery
  from deliveries d
  join delivery_items di on di.delivery_id = d.id
  left join store_product_ranging r
    on r.store_id = d.store_id and r.product_id = di.product_id
 where d.delivery_date >  jb_asof() - 7
   and d.delivery_date <= jb_asof()
   and coalesce(r.ranged, true)
 group by d.store_id, di.product_id;

comment on view v_store_product_delivered is
  'What was actually delivered per store-product in the seven days ending jb_asof(), from confirmed deliveries. The measured counterpart to store_reco.sent, which is the STANDING ORDER and is what the packing sheet falls back on. Same window and ranging filter as v_store_week, so a roll-up of delivered equals v_store_week.total_sent.';

-- security_invoker so row-level security applies as the caller, matching
-- v_store_week and v_unit_revenue. Without it a view owned by postgres reads
-- straight past every policy.
alter view v_store_product_delivered set (security_invoker = on);

-- ---------------------------------------------------------------------------
-- Check it agrees with v_store_week. Any row returned is a disagreement.
--
--   select w.store_id, w.total_sent, x.rolled
--     from v_store_week w
--     join (select store_id, sum(delivered)::int rolled
--             from v_store_product_delivered group by 1) x using (store_id)
--    where w.total_sent <> x.rolled;
-- ---------------------------------------------------------------------------
