-- =====================================================================
-- Jesse's Bakery Operating System — Migration 001: core schema
-- Postgres 16 / Supabase-compatible.
--
-- This is the same 22-table model from the System Blueprint, packaged as
-- a real migration. PostGIS (route optimisation, Phase 3) is split into
-- an additive migration (003_postgis.sql) so this core applies cleanly on
-- any Postgres — local dev or the hosted Supabase project. Store geo is
-- kept as plain lat/lng here; 003 upgrades it to geography() where PostGIS
-- is available.
--
-- Migration order to satisfy FKs: enums -> regions -> runs -> products ->
-- pricing_tiers -> product_prices -> app_users -> stores -> everything else.
-- =====================================================================

-- Idempotent reset: drop this app's objects if they already exist, so the
-- whole setup file can be re-run cleanly (e.g. after a partial run).
drop view if exists v_store_daily, v_waste_trend, v_network_week, v_region_week,
  v_store_week, v_asof cascade;
drop table if exists _facts, _drv, task_checklists, ingredient_receipts, packing_records,
  events, replenishment_plans, on_hand_ledger, wastage, delivery_photos, delivery_items,
  deliveries, feed_status_log, sales_intraday, sales_daily, standing_orders,
  store_run_overrides, stores, app_users, product_prices, pricing_tiers, products,
  runs, regions cascade;
drop function if exists jb_status(numeric,int) cascade;
drop type if exists retailer_type, store_size, product_category, delivery_status,
  app_role, weekday, feed_status, event_kind cascade;

create extension if not exists "pgcrypto";      -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- ENUMS
-- ---------------------------------------------------------------------
create type retailer_type      as enum ('coles','woolworths','harris_farm','invoice');
create type store_size         as enum ('small','medium','large','xlarge');
create type product_category   as enum ('sourdough','bagel','challah','pita','pastry','cake','other');
create type delivery_status    as enum ('pending','delivered','partial','circle_back','failed','skipped');
create type app_role           as enum ('admin','ops','baker','packer','driver');
create type weekday            as enum ('mon','tue','wed','thu','fri','sat','sun');
create type feed_status        as enum ('ok','stale','missing','error');
create type event_kind         as enum ('public_holiday','school_holiday','retail_event','store_custom');

-- ---------------------------------------------------------------------
-- REFERENCE: regions & runs  [P0]
-- ---------------------------------------------------------------------
create table regions (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  state         text not null default 'NSW',
  buffer_pct    numeric(5,2) default 0,
  created_at    timestamptz not null default now()
);

create table runs (
  id            uuid primary key default gen_random_uuid(),
  region_id     uuid not null references regions(id) on delete cascade,
  name          text not null,
  run_days      weekday[] not null default '{}',
  created_at    timestamptz not null default now(),
  unique (region_id, name)
);

-- ---------------------------------------------------------------------
-- PRODUCTS & PRICING  [P0/P2]
-- ---------------------------------------------------------------------
create table products (
  id                uuid primary key default gen_random_uuid(),
  name              text not null unique,
  category          product_category not null default 'other',
  is_core           boolean not null default false,
  lead_time_days    int not null default 1,          -- sourdough = 2, else 1
  shelf_life_days   int not null default 5,
  min_on_shelf      int not null default 2,          -- never send 1
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);

create table pricing_tiers (
  id            uuid primary key default gen_random_uuid(),
  name          text not null unique,
  created_at    timestamptz not null default now()
);

create table product_prices (
  tier_id       uuid not null references pricing_tiers(id) on delete cascade,
  product_id    uuid not null references products(id) on delete cascade,
  unit_price    numeric(10,2) not null,
  primary key (tier_id, product_id)
);

-- ---------------------------------------------------------------------
-- USERS & ROLES  [P2] — declared before stores/deliveries so FKs resolve
-- Links to Supabase auth.users (auth_user_id). PIN login for the
-- password-averse packers/drivers.
-- ---------------------------------------------------------------------
create table app_users (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique,
  full_name     text not null,
  email         text unique,
  pin_hash      text,
  role          app_role not null default 'packer',
  department    text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- STORES  [P0] — the CRM spine
-- ---------------------------------------------------------------------
create table stores (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  retailer          retailer_type not null,
  region_id         uuid references regions(id),
  default_run_id    uuid references runs(id),
  size_category     store_size,
  shelf_min         int,
  shelf_max         int,                             -- HARD cap — never exceed
  retailer_store_id text,                            -- 'STO235' from the scan system
  supplier_code     text,                            -- maps store <-> retailer sales report
  xero_contact_id   text,                            -- Xero Customer ID = Contact ID
  pricing_tier_id   uuid references pricing_tiers(id),
  address           text,
  postcode          text,
  lat               double precision,                -- 003_postgis.sql upgrades to geography()
  lng               double precision,
  active            boolean not null default true,
  onboarded_at      date,                            -- cold-start logic (new store < 3-4 weeks)
  created_at        timestamptz not null default now(),
  unique (retailer, retailer_store_id)
);
create index on stores (region_id);
create index on stores (retailer);

-- The Maroubra rule: a store rides a DIFFERENT run on specific days.
create table store_run_overrides (
  store_id      uuid not null references stores(id) on delete cascade,
  day           weekday not null,
  run_id        uuid not null references runs(id) on delete cascade,
  primary key (store_id, day)
);

create table standing_orders (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references stores(id) on delete cascade,
  product_id    uuid not null references products(id) on delete cascade,
  qty           int not null,
  days          weekday[] not null default '{}',
  active        boolean not null default true,
  unique (store_id, product_id)
);

-- ---------------------------------------------------------------------
-- SALES (from the 3 retailer feeds)  [P0]
-- Retailers report only what SOLD; waste is inferred, never reported.
-- ---------------------------------------------------------------------
create table sales_daily (
  store_id      uuid not null references stores(id) on delete cascade,
  product_id    uuid not null references products(id) on delete cascade,
  sale_date     date not null,
  units_sold    int not null default 0,
  source        retailer_type not null,
  loaded_at     timestamptz not null default now(),
  primary key (store_id, product_id, sale_date)
);
create index on sales_daily (sale_date);
create index on sales_daily (store_id, sale_date);

create table sales_intraday (
  store_id      uuid not null references stores(id) on delete cascade,
  product_id    uuid not null references products(id) on delete cascade,
  sold_at       timestamptz not null,
  units_sold    int not null default 0,
  primary key (store_id, product_id, sold_at)
);

create table feed_status_log (
  id            uuid primary key default gen_random_uuid(),
  source        retailer_type not null,
  as_of         date not null,
  status        feed_status not null,
  detail        text,
  checked_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- DELIVERIES & WASTAGE  [P0 data / P2 app]
-- ---------------------------------------------------------------------
create table deliveries (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references stores(id) on delete cascade,
  run_id        uuid references runs(id),
  driver_id     uuid references app_users(id),
  delivery_date date not null,
  status        delivery_status not null default 'pending',
  delivered_at  timestamptz,                         -- server-set at capture
  note          text,
  store_sig_name text,
  driver_sig_name text,
  created_at    timestamptz not null default now()
);
create index on deliveries (store_id, delivery_date);
create index on deliveries (delivery_date, status);

create table delivery_items (
  delivery_id   uuid not null references deliveries(id) on delete cascade,
  product_id    uuid not null references products(id) on delete cascade,
  qty_sent      int not null default 0,
  qty_delivered int,
  primary key (delivery_id, product_id)
);

create table delivery_photos (
  id            uuid primary key default gen_random_uuid(),
  delivery_id   uuid not null references deliveries(id) on delete cascade,
  storage_path  text not null,
  sha256        text not null,
  captured_at   timestamptz not null default now(),
  gps_lat       double precision,
  gps_lng       double precision,
  gps_accuracy_m double precision
);
create index on delivery_photos (delivery_id);

create table wastage (
  store_id      uuid not null references stores(id) on delete cascade,
  product_id    uuid not null references products(id) on delete cascade,
  waste_date    date not null,
  qty           int not null default 0,
  captured_by   uuid references app_users(id),
  primary key (store_id, product_id, waste_date)
);

-- ---------------------------------------------------------------------
-- ON-HAND LEDGER  [P0/P1] — THE HEART
-- on_hand(t) = on_hand(t-1) + delivered(t-1) - sold(t-1), floored at 0,
-- decayed by shelf_life. What the legacy system never had.
-- ---------------------------------------------------------------------
create table on_hand_ledger (
  store_id        uuid not null references stores(id) on delete cascade,
  product_id      uuid not null references products(id) on delete cascade,
  as_of_date      date not null,
  opening_on_hand int not null default 0,
  delivered       int not null default 0,
  sold            int not null default 0,
  expired         int not null default 0,
  closing_on_hand int not null default 0,
  reconciled      boolean not null default false,
  computed_at     timestamptz not null default now(),
  primary key (store_id, product_id, as_of_date)
);
create index on on_hand_ledger (as_of_date);

-- ---------------------------------------------------------------------
-- REPLENISHMENT PLANS  [P1] — the engine's output, auditable
-- ---------------------------------------------------------------------
create table replenishment_plans (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references stores(id) on delete cascade,
  product_id        uuid not null references products(id) on delete cascade,
  target_date       date not null,
  forecast_demand   numeric(10,2),
  target_stock      int,
  on_hand_estimate  int,
  recommended_qty   int not null,
  final_qty         int,
  capped_by_shelf   boolean not null default false,
  reason            text,
  model_version     text,
  created_at        timestamptz not null default now(),
  unique (store_id, product_id, target_date)
);
create index on replenishment_plans (target_date);
create index on replenishment_plans (store_id, target_date);

-- ---------------------------------------------------------------------
-- EVENTS CALENDAR  [P1] — seasonality the model must know about
-- ---------------------------------------------------------------------
create table events (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  kind          event_kind not null,
  state         text,
  start_date    date not null,
  end_date      date not null,
  uplift_pct    numeric(6,2),
  store_id      uuid references stores(id),
  created_at    timestamptz not null default now()
);
create index on events (start_date, end_date);

-- ---------------------------------------------------------------------
-- PACKING  [P2] — iPad tick-off with accountability
-- ---------------------------------------------------------------------
create table packing_records (
  id            uuid primary key default gen_random_uuid(),
  run_id        uuid not null references runs(id),
  pack_date     date not null,
  packed_by     uuid references app_users(id),
  completed     boolean not null default false,
  comment       text,
  finalised_at  timestamptz,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- INGREDIENTS / GOODS-IN & TASKS  [P3] — stubs
-- ---------------------------------------------------------------------
create table ingredient_receipts (
  id            uuid primary key default gen_random_uuid(),
  ingredient    text not null,
  expected_date date,
  received_date date,
  received_by   uuid references app_users(id),
  confirmed     boolean not null default false,
  area          text,
  created_at    timestamptz not null default now()
);

create table task_checklists (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  assigned_role app_role,
  due_date      date,
  completed     boolean not null default false,
  completed_by  uuid references app_users(id),
  completed_at  timestamptz,
  created_at    timestamptz not null default now()
);
