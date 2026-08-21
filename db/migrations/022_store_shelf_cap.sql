-- Migration 022: per-store shelf-cap override.
-- Source: Session 2 UAT (21 Aug 2026). The size bands give every store a default
--   shelf max, but Simona needs to override it per store — some run bigger or
--   smaller than their band, and a few (her example: Woolworths Mascot DC, which
--   picks to order for online) have no real ceiling at all and shouldn't trip the
--   over-cap warning.
--
-- Two additive columns on store_settings (migration 015): shelf_cap is a hand-set
-- override that replaces stores.shelf_max when present; no_cap = true means the
-- store picks to order and has no fixed limit (the app then never enforces a cap
-- for it). Absence / null / false = fall back to the size-band default. Both are
-- store-scoped business data — add to migration 014's RLS list before RLS is on.
-- Idempotent: add-if-not-exists. Safe to re-run.

alter table store_settings
  add column if not exists shelf_cap int,
  add column if not exists no_cap    boolean not null default false;

comment on column store_settings.shelf_cap is
  'Per-store shelf-cap override; replaces stores.shelf_max when set. Null = use the size-band default.';
comment on column store_settings.no_cap is
  'True = store picks to order / has no fixed shelf limit (e.g. a DC); the app enforces no cap.';

-- Verify:
--   select store_id, shelf_cap, no_cap from store_settings
--   where shelf_cap is not null or no_cap;
