-- 003_the_missing_migrations_reconstructed.sql
--
-- THIS IS NOT THE ORIGINAL 003 OR 004. Both were written, applied to
-- production, and never committed. The gap in the numbering is real and this
-- file does not close it honestly -- it closes it usefully.
--
-- WHAT WENT WRONG, MEASURED RATHER THAN ASSUMED
--
-- 10 September, all 89 migrations were applied in order to an empty Postgres
-- 16 for the first time. 78 applied. Eleven failed, and four of them failed on
-- columns that exist in production and are created by nothing in this
-- repository:
--
--   018  store_reco does not exist yet
--   024  column p.legacy_product_id does not exist
--   039  column coles_code does not exist
--   043  column s.legacy_store_id does not exist
--
-- The consequence is the one that matters at handover: Jesse's system exists
-- only as a running database. If it were lost, this repository could not stand
-- it back up. That was written down as a risk on 8 September; this is the first
-- time anyone tried it.
--
-- WHERE THESE DEFINITIONS COME FROM
--
-- information_schema.columns on the live database, 10 September. Every type and
-- nullability below was read off production, not inferred from how the columns
-- are used. Where the original migrations did something else as well -- 001's
-- own comment says "003_postgis.sql upgrades to geography()", so at least one of
-- them touched PostGIS -- that work is NOT reproduced here, because production
-- is the only record of it and it is not in evidence.
--
-- Every statement is `if not exists`, so this is a no-op against production and
-- a repair everywhere else. The same shape 033 already uses for store_reco.

-- ---------------------------------------------------------------------------
-- The retailer product codes. This is how a row in a Coles or Woolworths sales
-- report is matched to one of Jesse's products -- 039's loader reads
-- coles_code, so without these the feed ingest cannot be built from scratch.
-- ---------------------------------------------------------------------------
alter table products add column if not exists woolworths_code  text;
alter table products add column if not exists coles_code       text;
alter table products add column if not exists harris_farm_code text;
alter table products add column if not exists other_code       text;

-- ---------------------------------------------------------------------------
-- The legacy keys. Both are text in production, both nullable. They are what
-- the Azure load reconciled against, and 024 and 043 still read them.
-- ---------------------------------------------------------------------------
alter table products add column if not exists legacy_product_id text;
alter table stores   add column if not exists legacy_store_id   text;

-- ---------------------------------------------------------------------------
-- store_reco, needed by 018 and created by 033.
--
-- 033 carries the same `create table if not exists` and calls itself "a no-op
-- against production and a repair everywhere else" -- but it runs fifteen
-- migrations too late for 018, which lists store_reco among the tables it
-- enables row-level security on. Repeated here rather than moved, so 033 is
-- left exactly as it is.
--
-- Definition copied from 033, which transcribed it from the live table.
-- ---------------------------------------------------------------------------
create table if not exists store_reco (
  store_id    uuid not null references stores(id)   on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  sold        int not null default 0,
  sent        int not null default 0,
  recommended int not null default 0,
  primary key (store_id, product_id)
);
create index if not exists store_reco_store_idx on store_reco (store_id);

-- store_actuals, needed by 018 for the same reason and created by 033 for the
-- same reason. v_asof reads max(as_of) here, which is what the whole dashboard
-- means by "this week".
create table if not exists store_actuals (
  store_id uuid primary key references stores(id) on delete cascade,
  sent     int not null default 0,
  sold     int not null default 0,
  as_of    date
);

-- ---------------------------------------------------------------------------
-- Verify, on a FRESH database:
--
--   select count(*) from information_schema.columns
--    where table_schema='public'
--      and ((table_name='products' and column_name in
--            ('woolworths_code','coles_code','harris_farm_code','other_code',
--             'legacy_product_id'))
--        or (table_name='stores' and column_name='legacy_store_id'));
--   -- expect 6
--
-- Against production it should also return 6, and nothing should have changed.
-- ---------------------------------------------------------------------------
