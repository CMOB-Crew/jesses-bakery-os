-- Migration 023: store state (NSW / QLD / ACT).
-- Source: Session 2 UAT — Simona wants NSW and QLD run as ONE system with a state
--   filter (overview + production) and scoped access, not two separate entities.
--   This adds the field the filter reads. QLD stores aren't loaded yet (Somnath is
--   sending the QLD regions/runs); today's data is NSW + ACT, and QLD slots in the
--   moment those stores load — no rebuild.
-- Additive, nullable text. Loaded from the Stores Master via db/load-store-state.sql.
-- Idempotent: add-if-not-exists.

alter table stores add column if not exists state text;

comment on column stores.state is
  'Store state/territory (NSW, QLD, ACT). Drives the one-system state filter and scoped access.';

create index if not exists stores_state_idx on stores (state);
