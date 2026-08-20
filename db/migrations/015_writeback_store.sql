-- Migration 015: write-back for store ranging + per-store service level.
-- Source: write-back build (20 Aug 2026). Additive; safe to run any time. These
-- persist two store-profile controls that were previously local-only (reset on
-- reload) -- product ranging (in/out) and the service-level dial.
--
-- Idempotent: guarded creates. Add both to migration 014's RLS list before RLS
-- is enabled (they carry store-scoped business data).

-- Per-store product ranging (in/out). A row = an explicit choice for that
-- (store, product); absence = ranged by default. So we only store what Simona
-- actually toggled, and reads default everything else to "ranged".
create table if not exists store_product_ranging (
  store_id    uuid not null references stores(id)   on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  ranged      boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (store_id, product_id)
);
comment on table store_product_ranging is
  'Per-store product ranging (in/out). A row is an explicit choice; absence = ranged by default. Set from the store profile.';

-- Per-store settings. service_level is the waste-vs-stockout dial for the store.
-- One row per store; kept separate from the core stores table so the summary
-- schema stays untouched and settings can grow without altering stores.
create table if not exists store_settings (
  store_id      uuid primary key references stores(id) on delete cascade,
  service_level text check (service_level in ('lean','balanced','service')),
  updated_at    timestamptz not null default now(),
  updated_by    text
);
comment on table store_settings is
  'Per-store settings. service_level = the waste-vs-stockout dial (lean/balanced/service). Set from the store profile.';

-- Verify:
--   select * from store_product_ranging where store_id = :id;
--   select * from store_settings where store_id = :id;
