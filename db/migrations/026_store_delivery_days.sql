-- Migration 026: which days each store actually receives a delivery
--
-- Source: Simona's Stores Master (JessesBakery_Stores_2026-08-21.xlsx, emailed
-- during Session 2). One Yes/No column per weekday, per store.
--
-- Why this matters beyond the run sheet: the forecast engine was recommending
-- for EVERY active store on EVERY target day. Jesse doesn't deliver everywhere
-- daily -- 144 stores on a Monday, 101 on a Thursday, 50 on a Sunday. Unscoped,
-- the engine's sourdough plan came out at 5,246 units against Jesse's real
-- sheet of 2,566. Scoped to the 101 stores that actually get a Thursday drop it
-- lands at ~2,547 -- within 1% of his own printout.
--
-- Note runs.run_days is empty '{}' for all six runs, and only 95 of 265 active
-- stores have a default_run_id at all. So run-level days cannot answer this
-- today; the per-store data can, and it is more precise anyway (a store can sit
-- on a run but not take every drop).
--
-- NOT modelled here, deliberately:
--   * the per-day Override columns (the Maroubra rule -- a store riding a
--     different run on specific days). Needs the run data loaded first.
--   * "Special Friday" / "Special Sunday" flags -- meaning unconfirmed with
--     Simona.
--
-- Empty array = no scheduled delivery day. 7 active stores are genuinely blank
-- in her sheet; they are left empty rather than guessed, and the engine simply
-- won't plan for them until someone confirms their days.
--
-- Idempotent: guarded add. Safe to run more than once.

alter table stores add column if not exists delivery_days weekday[] not null default '{}';

comment on column stores.delivery_days is
  'Weekdays this store receives a delivery, from Simona''s Stores Master. Drives forecast scoping: the engine only plans a store for a target date that falls on one of these days. Empty = no scheduled day (7 active stores, blank in her sheet).';

create index if not exists stores_delivery_days_idx on stores using gin (delivery_days);
