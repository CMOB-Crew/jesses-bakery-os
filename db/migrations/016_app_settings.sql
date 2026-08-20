-- Migration 016: app_settings — a small key/value (JSONB) store for the global
-- config Simona sets on the Settings page (service level, per-product minimums,
-- size baskets, shelf life / lead times, seasonality factor toggles). Previously
-- all of it was local-only and reset on reload.
--
-- One row per config group, value is JSONB so each group's shape can grow
-- without a schema change. Additive/idempotent. Add to 014's RLS list before RLS.
create table if not exists app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
comment on table app_settings is
  'Global app config as key/value JSONB. Keys: service_level, product_minimums, size_baskets, shelf_lead, seasonality_factors. Set from the Settings page.';

-- Verify:
--   select key, value from app_settings order by key;
