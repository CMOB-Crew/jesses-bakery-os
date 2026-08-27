-- =====================================================================
-- Migration 060: correct the Rosh Hashanah window and rate. 058/059 had the
-- right products and the right stores, and the wrong days and the wrong
-- number.
--
-- ---------------------------------------------------------------------
-- WHAT REPORT 2 OF check-holiday-window.sh SHOWED
-- ---------------------------------------------------------------------
-- Challah loaves are a Thursday/Friday product. The BASELINE by weekday,
-- 2025, network-wide:
--
--     Thu 354   Fri 710   Sat 50   Sun 17   Mon 2   Tue 1   Wed 2
--
-- Monday to Wednesday it is essentially not sold. 2024 has the same shape
-- (Thu 144, Fri 336, Mon 6, Tue 3).
--
-- So the enormous percentages in that report — 46,486% on the 2025 eve — are
-- dividing by a baseline of two. The 2025 eve fell on a MONDAY. That is not a
-- 465-fold uplift; it is a product appearing on a day it does not belong.
--
-- WHICH MEANS A PERCENTAGE IS THE WRONG INSTRUMENT. The engine computes
-- forecast_demand as mean * coverage * (1 + uplift), where mean is the
-- per-weekday mean of the last six same weekdays. With a baseline that swings
-- 350x across the week, one percentage produces a completely different
-- absolute answer depending on which weekday the holiday lands on:
--
--     2025 eve  Monday      2024 eve  Wednesday      2026 eve  FRIDAY
--
-- No two of those are comparable, and 2026 is the one that has never happened
-- in the data we hold.
--
-- ---------------------------------------------------------------------
-- WHAT IS STABLE — the anchor this migration uses
-- ---------------------------------------------------------------------
-- Measure the eve against a NORMAL FRIDAY instead, and both years agree:
--
--                    eve sold    normal Fri    ratio
--     2024              503         ~330       1.52x
--     2025            1,087         ~715       1.52x
--
-- The day before the eve: 452/330 = 1.37x and 679/715 = 0.95x, so ~1.15x.
-- The two holiday days after: ~0.22x and ~0.10x of a normal Friday.
--
-- Applying those to 2026, where the eve IS a Friday and Thursday's own
-- baseline is about half a Friday:
--
--     Thu 10 Sep   baseline 0.50F   target 1.15F   would need +130%
--     Fri 11 Sep   baseline 1.00F   target 1.50F   would need  +50%
--     Sat 12 Sep   baseline 0.07F   target 0.22F   would need +215%
--     Sun 13 Sep   baseline 0.02F   target 0.10F   would need +320%
--
--     combined     baseline 1.59F   target 2.97F   -> +86%
--
-- ---------------------------------------------------------------------
-- THE DECISION, AND ITS LIMIT — stated plainly
-- ---------------------------------------------------------------------
-- One event carrying +90% across Thu 10 to Sun 13 gets the SEASON TOTAL
-- right. The distribution within it is approximate: slightly heavy on the
-- Friday, slightly light on the Thursday.
--
-- Four one-day events would be more precise. They are NOT written here,
-- because the per-day ratios rest on two observations at two different
-- weekday alignments, neither of which is 2026's. Encoding four numbers to
-- that precision would be false confidence. The season total rests on the
-- 1.52x anchor, which both years agree on exactly, and that is the part worth
-- trusting.
--
-- Simona baked last Rosh Hashanah and knows what went out. This is a
-- defensible default for her to adjust, not a substitute for asking her.
--
-- ---------------------------------------------------------------------
-- WHAT CHANGES
-- ---------------------------------------------------------------------
--   window   11-13 Sep  ->  10-13 Sep   (it missed the day before the eve
--                                        entirely, and both years put a
--                                        large lift there)
--   challah  +230%      ->  +90%
--   babka    +290%      ->  unchanged in rate, moved to the same window.
--                           Babka's weekday pattern was never measured and
--                           it is 152 units a week planned, so the absolute
--                           risk either way is small. Flagged, not guessed.
--
-- Yom Kippur is left alone. Report 3 says its run-up FALLS (-52% in 2024,
-- -37% in 2025) and only the eve lifts, which is what -13% across the group
-- already approximates.
--
-- Reversible via jb_events_backup_056. Idempotent.
-- =====================================================================

\set ON_ERROR_STOP on

\echo ''
\echo '=== BEFORE ==='
select name, start_date, end_date, uplift_pct,
       (start_date - date '2026-09-11') as starts_at_offset,
       (end_date   - date '2026-09-11') as ends_at_offset
  from events where name like 'Rosh Hashanah%' order by name;

update events
   set start_date = date '2026-09-10',
       end_date   = date '2026-09-13',
       uplift_pct = 90,
       note = 'Rate set from the eve-to-normal-Friday ratio, which is 1.52x in both 2024 and 2025. A percentage on the raw weekday baseline is unstable here: challah loaves are a Thu/Fri product (2025 baseline Thu 354, Fri 710, Mon 2), so the same percentage means something different depending on which weekday the eve falls on. 2026 is the first Friday eve in the data. +90% across Thu-Sun reproduces the measured season total; the split within those four days is approximate.'
 where name = 'Rosh Hashanah - challah loaves';

update events
   set start_date = date '2026-09-10',
       end_date   = date '2026-09-13',
       note = 'Rate +290% from 2025 (108 -> 422 over the four days to the eve), corroborated directionally by 2024 (4 -> 48). Babka''s weekday baseline was NOT measured, so unlike the challah rate this one is not weekday-adjusted. 152 units a week planned, so the absolute exposure is small either way.'
 where name = 'Rosh Hashanah - babka';

\echo ''
\echo '=== AFTER ==='
select name, start_date, end_date, uplift_pct,
       (start_date - date '2026-09-11') as starts_at_offset,
       (end_date   - date '2026-09-11') as ends_at_offset,
       coalesce(cardinality(store_ids),0)   as stores,
       coalesce(cardinality(product_ids),0) as products
  from events where name like 'Rosh Hashanah%' order by name;

\echo ''
\echo '=== the four days it now covers ==='
select d::date as day, to_char(d, 'Dy') as weekday,
       case when d = date '2026-09-11' then 'the eve'
            when d <  date '2026-09-11' then 'run-up'
            else 'holiday day' end as what
  from generate_series(date '2026-09-10', date '2026-09-13', interval '1 day') d;

\echo ''
\echo '=== SANITY: the season total this implies, against 2025 actual ==='
\echo '    2025 moved 2,586 challah loaves network-wide over its four-day'
\echo '    season against a 780 baseline. The check is whether the multiplier'
\echo '    lands in the same neighbourhood once the weekday mix is accounted'
\echo '    for — not that it matches, since the network has grown since.'
select round(780 * 1.0)                        as baseline_2025,
       round(2586 * 1.0)                       as actual_2025,
       round(2586.0 / 780, 2)                  as actual_multiple,
       round(1 + 90 / 100.0, 2)                as multiple_now_set,
       'the gap is the weekday mix: 2025 ran Fri-Mon, 2026 runs Thu-Sun' as why;

\echo ''
\echo '=== every holiday event, final ==='
select e.name, e.start_date, e.end_date, e.uplift_pct,
       coalesce(cardinality(e.store_ids),0)   as stores,
       coalesce(cardinality(e.product_ids),0) as products
  from events e
 where e.start_date between '2026-09-01' and '2026-10-31'
 order by e.start_date, e.name;

-- Undo:
--   update events e set start_date = b.start_date, end_date = b.end_date,
--          uplift_pct = b.uplift_pct
--     from jb_events_backup_056 b where b.id = e.id;
