-- Migration 011: store-level per-product override plan
-- Source: Simona's "most important screen" is the store profile (Discovery Call 2).
--   She sets a product's final delivery by hand when she knows something the
--   engine does not -- a promo, a known slow week, a standing instruction from a
--   store manager. Until now those edits were live only in the browser and reset
--   on reload. This table is where they persist.
--
-- One row per (store, product). qty is the final delivery Simona wants for that
-- line, overriding the engine's recommended order-up-to. Two modes:
--   * perm -- a standing override; applies until she changes or removes it.
--   * temp -- a date-ranged override; starts_on..ends_on. Reads filter out temp
--     rows whose ends_on is in the past, so a temporary change auto-expires with
--     no cleanup job. The row stays for history; it just stops applying.
--
-- This is the write-back layer's first slice: the profile now saves. Propagating
-- an override into the delivery sheet / production totals is a later slice; for
-- now it persists on the profile and survives reload.
--
-- Idempotent: create-if-not-exists. Safe to run more than once.

create table if not exists store_product_overrides (
  store_id    uuid not null references stores(id)   on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  qty         int  not null check (qty >= 0),
  mode        text not null default 'perm' check (mode in ('perm','temp')),
  starts_on   date,
  ends_on     date,
  note        text,
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (store_id, product_id)
);

comment on table store_product_overrides is
  'Per-store, per-product manual override of the engine recommended order. qty is the final delivery. mode perm = standing; mode temp = date-ranged (auto-expires past ends_on). Set from the store profile.';

-- Active overrides for a store: all perm rows, plus temp rows not yet expired.
-- (Kept as a comment for reference; the app filters inline in getStoreOverrides.)
--   select * from store_product_overrides
--   where store_id = :id
--     and (mode = 'perm' or ends_on is null or ends_on >= current_date);

-- Verify after apply:
--   select count(*) as overrides,
--          count(*) filter (where mode = 'temp') as temporary
--   from store_product_overrides;
