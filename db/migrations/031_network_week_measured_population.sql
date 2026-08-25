-- 031 — the network summary must measure over one population, not two
--
-- Found 25 Aug 2026 walking the live app before the client session. The
-- Overview was showing two different waste numbers on the same screen:
--
--   engine panel   34.3% waste   "95 stores that report sales"
--   Today strip    15.6% waste   sell-through 29.6%
--
-- Both came from the database. Neither was a rounding difference. If stores are
-- only selling 29.6% of what is delivered, waste cannot be 15.6% — the two
-- figures were arithmetically incompatible, and the more flattering one was in
-- the bigger type.
--
-- Migration 027 did the hard part correctly: a store with no sales feed gets a
-- NULL waste, not a zero and not 100%, because its waste is unknowable rather
-- than good or bad. What it did not do was carry that same care one level up.
-- v_network_week summed those NULLs away in the numerator while leaving every
-- no-feed store's delivered units in the denominator:
--
--   waste from the 94 reporting stores    19,408 - 12,759  =  6,649
--   divided by everything delivered                          43,062
--                                                          = 15.4%   <- wrong
--   divided by what those same stores got                    19,408
--                                                          = 34.3%   <- right
--
-- Same for sell-through: 12,759 / 43,062 reads 29.6%, when the stores that
-- actually reported those sales were sent 19,408 and sold 65.7% of it. The
-- other 153 stores are invoice customers who never scan; counting their
-- deliveries as unsold is the exact error 027 was written to prevent.
--
-- So this view now reports the measured figures over the measured population,
-- and names that population so the app can say which stores a number is about.
-- waste_pct changes meaning here — deliberately. It becomes the same 34.3% the
-- engine panel quotes, computed the same way, from the same rows.
--
-- total_sent / total_sold / total_wasted keep their current meaning so nothing
-- else silently shifts: total_sent is still everything delivered network-wide.
-- The new feed_* columns are the honest pair for any ratio.
--
-- Idempotent: create or replace, columns appended at the end.

create or replace view v_network_week as
select
  count(*)                                          as stores,
  count(*) filter (where status = 'red')::int       as red,
  count(*) filter (where status = 'amber')::int     as amber,
  count(*) filter (where status = 'green')::int     as green,
  sum(total_sent)::int                              as total_sent,
  sum(total_sold)::int                              as total_sold,
  sum(total_wasted)::int                            as total_wasted,
  -- Numerator and denominator from the same stores. This is the number the
  -- Overview headline shows and the number the engine panel quotes.
  round(
    100.0 * sum(total_wasted) filter (where has_sales_feed)
    / nullif(sum(total_sent) filter (where has_sales_feed), 0)
  , 1)                                              as waste_pct,
  -- The measured population, so the app can caption it rather than imply the
  -- figure covers all 265 stores.
  count(*) filter (where has_sales_feed)::int       as feed_stores,
  coalesce(sum(total_sent)   filter (where has_sales_feed), 0)::int as feed_sent,
  coalesce(sum(total_sold)   filter (where has_sales_feed), 0)::int as feed_sold,
  coalesce(sum(total_wasted) filter (where has_sales_feed), 0)::int as feed_wasted
from v_store_week;

-- Recreating a view drops the invoker setting (migration 013); re-assert it or
-- every RLS policy underneath stops applying to the caller.
alter view v_network_week set (security_invoker = on);
