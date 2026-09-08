-- =====================================================================
-- Migration 087: the number on the front page has no date, and the
-- screen said it was "right now".
--
-- engine_projection holds the four scenarios the Overview's hero panel
-- reads -- current system waste, and lean / balanced / service-leaning
-- with the plan. The panel captioned them:
--
--     "204 stores that report sales - this week - at the last engine run"
--
-- MEASURED, 8 SEPTEMBER 2026. The only write to engine_projection
-- anywhere in this repository is migration 005's seed:
--
--     current 32.5 | lean 19.1 | balanced 22.5 | service 26.9
--
-- Production today reads:
--
--     current 34.3 | lean 20.4 | balanced 22.6 | service 26.3
--
-- So the rows HAVE been updated -- by hand, outside the migration set,
-- on a date nobody recorded. jb_run_engine() does not touch this table.
-- 033 reads it once to seed engine_service_levels and never writes back.
-- The nightly engine has never produced these figures.
--
-- The numbers are not wrong. They were measured off the real ledger.
-- What was wrong is a screen calling them current when nothing keeps
-- them current -- and this is the figure the client quotes to the owner.
--
-- THIS ADDS THE COLUMN THAT LETS THE PANEL TELL THE TRUTH. Nullable,
-- and deliberately NOT backfilled: we do not know when those rows were
-- computed, and inventing a date would be a worse lie than the one
-- being fixed. Until something writes it, the panel says "date not
-- recorded" in plain words.
--
-- NOT DONE HERE, on purpose: making it recompute nightly. Once the
-- bakery runs on the plan, "current system waste" becomes a
-- counterfactual -- there is no unplanned bakery left to measure. That
-- needs a decision about what the baseline means, not a cron entry, and
-- not the week of go-live.
--
-- RLS: 018 put a business read policy on this table and forced RLS.
-- Adding a column does not change a policy, and nothing here grants
-- anything new.
--
-- Additive, idempotent, one column. No data changes.
-- =====================================================================

begin;

alter table engine_projection
  add column if not exists computed_at timestamptz;

comment on column engine_projection.computed_at is
  'When these figures were last computed. NULL means unknown -- the rows predate this column and were written by hand outside the migration set. Nothing in this codebase writes engine_projection; if that ever changes, set this in the same statement that writes the numbers. Migration 087, 8 September 2026.';

commit;

-- ---------------------------------------------------------------------
-- VERIFY. Run this and read it.
--
--   select scenario, waste_pct, computed_at
--     from engine_projection order by ord;
--
-- Expect four rows and computed_at null on every one of them. Null is
-- the correct answer here, not a failure: it is the honest record that
-- nobody knows when these were worked out.
-- ---------------------------------------------------------------------
