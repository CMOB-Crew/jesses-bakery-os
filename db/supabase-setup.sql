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
-- =====================================================================
-- Migration 002: reporting views
-- These encapsulate the waste / status / trend logic so the app reads
-- simple rows. Everything is anchored to v_asof (the latest data date),
-- so the dashboard's "this week" tracks the freshest feed, not the wall
-- clock. Waste source of truth is the wastage table (driver-captured);
-- it falls back to inferred (sent - sold) when a store has no capture yet.
-- =====================================================================

-- Latest date we have sales for — the app's "as of".
create or replace view v_asof as
  select coalesce(max(sale_date), current_date) as as_of from sales_daily;

-- Status thresholds, centralised so the app never hardcodes them.
-- red:   waste > 30%  OR  >= 3 stockout days
-- amber: waste >= 20% OR  >= 1 stockout day
-- green: otherwise
create or replace function jb_status(waste_pct numeric, stockout_days int)
returns text language sql immutable as $$
  select case
    when waste_pct > 30 or stockout_days >= 3 then 'red'
    when waste_pct >= 20 or stockout_days >= 1 then 'amber'
    else 'green' end
$$;

-- ---------------------------------------------------------------------
-- Per-store, trailing 7 days ending at as_of
-- ---------------------------------------------------------------------
create or replace view v_store_week as
with a as (select as_of from v_asof),
sold as (
  select s.store_id, sum(s.units_sold)::int total_sold
  from sales_daily s, a
  where s.sale_date >  a.as_of - interval '7 days'
    and s.sale_date <= a.as_of
  group by s.store_id
),
sold_prev as (
  select s.store_id, sum(s.units_sold)::int total_sold_prev
  from sales_daily s, a
  where s.sale_date >  a.as_of - interval '14 days'
    and s.sale_date <= a.as_of - interval '7 days'
  group by s.store_id
),
sent as (
  select d.store_id, sum(di.qty_sent)::int total_sent
  from deliveries d
  join delivery_items di on di.delivery_id = d.id, a
  where d.delivery_date >  a.as_of - interval '7 days'
    and d.delivery_date <= a.as_of
  group by d.store_id
),
waste as (
  select w.store_id, sum(w.qty)::int total_wasted
  from wastage w, a
  where w.waste_date >  a.as_of - interval '7 days'
    and w.waste_date <= a.as_of
  group by w.store_id
),
stk as (
  -- a stockout day = shelf hit zero with nothing left to expire; if stock
  -- was left over to expire, the store didn't run out.
  select l.store_id,
         count(*) filter (where l.closing_on_hand = 0 and l.expired = 0)::int stockout_days
  from on_hand_ledger l, a
  where l.as_of_date >  a.as_of - interval '7 days'
    and l.as_of_date <= a.as_of
  group by l.store_id
)
select
  st.id                                        as store_id,
  st.name,
  st.retailer,
  st.size_category,
  st.shelf_max,
  st.region_id,
  reg.name                                     as region,
  coalesce(sent.total_sent, 0)                 as total_sent,
  coalesce(sold.total_sold, 0)                 as total_sold,
  coalesce(sold_prev.total_sold_prev, 0)       as total_sold_prev,
  coalesce(
    waste.total_wasted,
    greatest(coalesce(sent.total_sent,0) - coalesce(sold.total_sold,0), 0)
  )                                            as total_wasted,
  coalesce(stk.stockout_days, 0)               as stockout_days,
  round(
    100.0 * coalesce(
      waste.total_wasted,
      greatest(coalesce(sent.total_sent,0) - coalesce(sold.total_sold,0), 0)
    ) / nullif(coalesce(sent.total_sent,0), 0)
  , 1)                                         as waste_pct,
  jb_status(
    round(
      100.0 * coalesce(
        waste.total_wasted,
        greatest(coalesce(sent.total_sent,0) - coalesce(sold.total_sold,0), 0)
      ) / nullif(coalesce(sent.total_sent,0), 0)
    , 1),
    coalesce(stk.stockout_days, 0)
  )                                            as status
from stores st
left join regions reg on reg.id = st.region_id
left join sold      on sold.store_id      = st.id
left join sold_prev on sold_prev.store_id = st.id
left join sent      on sent.store_id      = st.id
left join waste     on waste.store_id     = st.id
left join stk       on stk.store_id       = st.id
where st.active;

-- ---------------------------------------------------------------------
-- Per-region rollup
-- ---------------------------------------------------------------------
create or replace view v_region_week as
select
  region_id,
  region,
  count(*)                                            as stores,
  count(*) filter (where status = 'red')::int         as red,
  count(*) filter (where status = 'amber')::int       as amber,
  count(*) filter (where status = 'green')::int       as green,
  sum(total_sent)::int                                as total_sent,
  sum(total_sold)::int                                as total_sold,
  sum(total_wasted)::int                              as total_wasted,
  round(100.0 * sum(total_wasted) / nullif(sum(total_sent),0), 1) as waste_pct
from v_store_week
group by region_id, region;

-- ---------------------------------------------------------------------
-- Network single-row summary
-- ---------------------------------------------------------------------
create or replace view v_network_week as
select
  count(*)                                        as stores,
  count(*) filter (where status='red')::int       as red,
  count(*) filter (where status='amber')::int     as amber,
  count(*) filter (where status='green')::int     as green,
  sum(total_sent)::int                            as total_sent,
  sum(total_sold)::int                            as total_sold,
  sum(total_wasted)::int                          as total_wasted,
  round(100.0 * sum(total_wasted) / nullif(sum(total_sent),0), 1) as waste_pct
from v_store_week;

-- ---------------------------------------------------------------------
-- 6-week network waste trend (feeds the signature chart)
-- wk 0 = most recent 7-day window, wk 5 = oldest.
-- ---------------------------------------------------------------------
create or replace view v_waste_trend as
with a as (select as_of from v_asof)
select
  g.wk,
  (select coalesce(sum(di.qty_sent),0)
     from deliveries d join delivery_items di on di.delivery_id = d.id, a
    where d.delivery_date >  a.as_of - ((g.wk+1)*7) * interval '1 day'
      and d.delivery_date <= a.as_of - (g.wk*7) * interval '1 day')::int as sent,
  (select coalesce(sum(w.qty),0)
     from wastage w, a
    where w.waste_date >  a.as_of - ((g.wk+1)*7) * interval '1 day'
      and w.waste_date <= a.as_of - (g.wk*7) * interval '1 day')::int as wasted
from generate_series(0,5) as g(wk), a;

-- ---------------------------------------------------------------------
-- Per-store daily units this week (for the store-detail bars)
-- ---------------------------------------------------------------------
create or replace view v_store_daily as
with a as (select as_of from v_asof)
select
  d.store_id,
  d.sale_date,
  to_char(d.sale_date, 'Dy')      as dow,
  d.units_sold::int               as sold,
  coalesce(sent.qty_sent, 0)::int as sent
from (
  select s.store_id, s.sale_date, sum(s.units_sold) units_sold
  from sales_daily s, a
  where s.sale_date > a.as_of - interval '7 days' and s.sale_date <= a.as_of
  group by s.store_id, s.sale_date
) d
left join (
  select dl.store_id, dl.delivery_date, sum(di.qty_sent) qty_sent
  from deliveries dl join delivery_items di on di.delivery_id = dl.id, a
  where dl.delivery_date > a.as_of - interval '7 days' and dl.delivery_date <= a.as_of
  group by dl.store_id, dl.delivery_date
) sent on sent.store_id = d.store_id and sent.delivery_date = d.sale_date;
-- =====================================================================
-- Jesse's Bakery OS — compact server-side seed (hosted Postgres / Supabase)
--
-- Generates the whole 84-store network inside the database. The fact
-- generation lives inside a single DO block so the whole thing runs as ONE
-- statement — Supabase's SQL editor can't lose the worktable between steps.
-- Deterministic-ish via setseed(); safe to re-run (truncates first).
-- =====================================================================
truncate wastage, delivery_items, deliveries, on_hand_ledger, sales_daily,
         replenishment_plans, feed_status_log, events, stores, runs, regions,
         product_prices, products, pricing_tiers, app_users restart identity cascade;
select setseed(0.42);

insert into pricing_tiers(name) values ('Coles'),('Woolworths'),('Harris Farm'),('Cafe'),('Distributor');

insert into products(name,category,is_core,lead_time_days,shelf_life_days,min_on_shelf) values
  ('White Sourdough','sourdough',true,2,5,2),
  ('Rye Sourdough','sourdough',false,2,5,2),
  ('Plain Bagel','bagel',true,1,4,2),
  ('Sesame Bagel','bagel',false,1,4,2),
  ('Poppy Bagel','bagel',false,1,4,2),
  ('Mini Challah','challah',false,1,3,2),
  ('Pita','pita',false,1,7,3);

insert into app_users(full_name,email,role,department) values
  ('Simona','simona@jessesbakery.com.au','ops','Operations'),
  ('Jesse','jesse@jessesbakery.com.au','admin','Owner'),
  ('Dan Kelly','dan@jessesbakery.com.au','driver','Logistics'),
  ('Mike Rowe','mike@jessesbakery.com.au','driver','Logistics'),
  ('Ana Silva','ana@jessesbakery.com.au','packer','Bakery');

insert into regions(name,state) values
  ('Eastern Suburbs','NSW'),('Inner West','NSW'),('City','NSW'),('North Shore','NSW'),
  ('South','NSW'),('Northern Beaches','NSW'),('Hills','NSW'),('Western Sydney','NSW'),
  ('Canberra','ACT'),('Central Coast','NSW'),('Newcastle','NSW'),('Northwest','NSW');

insert into runs(region_id,name,run_days)
  select id, name||' run', '{mon,tue,wed,thu,fri,sat,sun}'::weekday[] from regions;

with mk as (
  select r.id region_id, r.name region_name, gs.i,
         row_number() over (order by r.name, gs.i) rn,
         random() rsize, random() rret, random() rprob
  from regions r cross join generate_series(1,7) gs(i)
)
insert into stores(name,retailer,region_id,default_run_id,size_category,shelf_min,shelf_max,
  retailer_store_id,supplier_code,xero_contact_id,pricing_tier_id,postcode,onboarded_at)
select
  (case when rret<0.34 then 'Coles' when rret<0.67 then 'Woolworths' else 'Harris Farm' end)||' '||region_name||' '||i,
  (case when rret<0.34 then 'coles' when rret<0.67 then 'woolworths' else 'harris_farm' end)::retailer_type,
  region_id,
  (select id from runs where runs.region_id = mk.region_id limit 1),
  (case when rsize<0.34 then 'small' when rsize<0.74 then 'medium' else 'large' end)::store_size,
  5,
  (case when rsize<0.34 then 45 when rsize<0.74 then 75 else 150 end),
  'STO'||(100+rn),
  (100+floor(rret*899))::text,
  gen_random_uuid()::text,
  (select id from pricing_tiers pt where pt.name = (case when rret<0.34 then 'Coles' when rret<0.67 then 'Woolworths' else 'Harris Farm' end)),
  (2000+floor(rsize*914))::text,
  current_date - (120+floor(rprob*700))::int
from mk;

-- ---- facts + all fact tables, generated inside ONE statement ----------
do $$
begin
  create temp table _facts as
  with d3 as (
    select
      s.id store_id, p.id product_id, s.retailer, s.shelf_max, s.default_run_id, p.min_on_shelf,
      g.d::date sale_date,
      (case s.size_category when 'small' then 8.0 when 'medium' then 18.0 when 'large' then 34.0 else 14.0 end)
        * (0.8 + (('x'||substr(md5(s.id::text),1,4))::bit(16)::int % 100)/250.0) as sbase,
      (case p.category when 'sourdough' then 1.0 when 'bagel' then 0.7 when 'challah' then 0.4 else 0.5 end) as pop,
      (case extract(dow from g.d)::int when 0 then 1.4 when 6 then 1.55 when 5 then 1.3
            when 4 then 1.0 when 3 then 0.95 else 0.85 end) as dmult,
      (('x'||substr(md5(s.id::text),5,2))::bit(8)::int % 100) as sh,
      (('x'||substr(md5(s.id::text||p.id::text||g.d::text),1,4))::bit(16)::int % 100) as noise
    from stores s
    cross join products p
    cross join generate_series(current_date - 41, current_date, interval '1 day') g(d)
  ),
  d4 as (
    select *,
      greatest(0, round(sbase * pop * dmult * (0.82 + noise/330.0)))::int as demand,
      (1.12 + (sh % 16)/100.0 + case when sh < 9 then 0.75 else 0 end) as overs
    from d3
  )
  select store_id, product_id, retailer, shelf_max, default_run_id, min_on_shelf, sale_date, demand,
         least(shelf_max, greatest(min_on_shelf, round(sbase * pop * dmult * overs)::int)) as sent
  from d4;

  create temp table _drv as select id, row_number() over () rn from app_users where role='driver';

  insert into deliveries(id, store_id, run_id, driver_id, delivery_date, status, delivered_at)
  select distinct md5(store_id::text||sale_date::text)::uuid, store_id, default_run_id,
         (select id from _drv where rn = 1 + (('x'||substr(md5(store_id::text),1,2))::bit(8)::int % 2)),
         sale_date, 'delivered'::delivery_status, sale_date
  from _facts;

  insert into delivery_items(delivery_id, product_id, qty_sent, qty_delivered)
  select md5(store_id::text||sale_date::text)::uuid, product_id, sent, sent from _facts;

  insert into sales_daily(store_id, product_id, sale_date, units_sold, source)
  select store_id, product_id, sale_date, least(demand, sent), retailer from _facts;

  insert into wastage(store_id, product_id, waste_date, qty, captured_by)
  select store_id, product_id, sale_date, round(greatest(sent - demand, 0) * 0.55)::int,
         (select id from _drv where rn=1)
  from _facts where round(greatest(sent - demand, 0) * 0.55)::int > 0;

  insert into on_hand_ledger(store_id, product_id, as_of_date, opening_on_hand, delivered, sold, expired, closing_on_hand)
  select store_id, product_id, sale_date, 0, sent, least(demand, sent),
         round(greatest(sent - demand, 0) * 0.55)::int,
         greatest(sent - demand, 0) - round(greatest(sent - demand, 0) * 0.55)::int
  from _facts;

  drop table _facts;
  drop table _drv;
end $$;

-- ---- feed health + events ------------------------------------------
insert into feed_status_log(source, as_of, status, detail) values
  ('coles', current_date, 'ok', 'current'),
  ('woolworths', current_date, 'ok', 'current'),
  ('harris_farm', current_date - 2, 'stale', 'last loaded 2 days ago');

insert into events(name, kind, state, start_date, end_date, uplift_pct) values
  ('Christmas','retail_event',null, make_date(extract(year from current_date)::int,12,18), make_date(extract(year from current_date)::int,12,24), 40),
  ('Easter','public_holiday',null, make_date(extract(year from current_date)::int,4,3), make_date(extract(year from current_date)::int,4,6), 25),
  ('NSW School Holidays','school_holiday','NSW', make_date(extract(year from current_date)::int,7,1), make_date(extract(year from current_date)::int,7,14), -15);

select 'seeded' as status,
       (select count(*) from stores) as stores,
       (select count(*) from sales_daily) as sales_rows,
       (select waste_pct from v_network_week) as network_waste_pct;
