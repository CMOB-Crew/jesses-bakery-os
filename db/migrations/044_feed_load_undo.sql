-- =====================================================================
-- Migration 044: make a feed load reversible.
--
-- WHY THIS EXISTS, and why it exists BEFORE the first real Coles load rather
-- than after it.
--
-- jb_load_feed_upload() ends with:
--
--     insert into sales_daily (...)
--     on conflict (store_id, product_id, sale_date) do update
--        set units_sold = excluded.units_sold, ...
--
-- Two problems in that one statement.
--
-- 1. sales_daily carries NO upload provenance. There is no column saying which
--    upload wrote a row, so there is no way to say "undo upload X". Once it is
--    in, it is indistinguishable from every other row.
--
-- 2. It OVERWRITES. Any (store, product, date) we already hold has its
--    units_sold replaced and the previous value is gone.
--
-- On this database that is not a theoretical risk. There are no backups and no
-- point-in-time recovery — the project is on the Supabase free tier. One wrong
-- file, one column mapped to the wrong field, one report covering dates it
-- should not, and good sales history is destroyed with nothing to restore from.
--
-- And it is not hypothetical for the very next load. The Coles gap is not a
-- clean cutoff: there are rows on 8 Aug, then 3, 2 and 1 Aug, and nothing on
-- the 4th to the 7th. A re-issue covering 4 Aug onward therefore lands on top
-- of dates we already hold, so the FIRST real Coles load will take the update
-- path, not the insert path.
--
-- WHAT THIS DOES
--
-- Before the merge, snapshot the prior state of exactly the keys the merge is
-- about to touch — including the fact that a key did not exist, which is the
-- half that is easy to forget and the half that makes "undo" mean delete
-- rather than restore.
--
-- Rows only for affected keys, so a Coles day is roughly 900 rows and the whole
-- 14-day backlog about 12,000. Measured cost at 340 bytes/row: under 5 MB.
-- Prunable once a load is confirmed good.
--
-- Idempotent, safe to re-run.
-- =====================================================================

\set ON_ERROR_STOP on

create table if not exists feed_load_undo (
  upload_id          uuid not null references feed_uploads(id) on delete cascade,
  store_id           uuid not null,
  product_id         uuid not null,
  sale_date          date not null,
  -- Null when the row did not exist. `existed` is what distinguishes "it was
  -- zero" from "it was not there" — the same distinction that has bitten this
  -- build on shelf caps, on stockouts and on invoice customers' sales.
  existed            boolean not null,
  prior_units_sold   int,
  prior_source       retailer_type,
  prior_invoice_cost numeric(12,4),
  snapped_at         timestamptz not null default now(),
  primary key (upload_id, store_id, product_id, sale_date)
);

comment on table feed_load_undo is
  'Prior state of every sales_daily key a feed load was about to overwrite, captured before the merge. The only way back from a bad upload on a database with no backups and no PITR. Undo with jb_undo_feed_upload(upload_id). Safe to prune once a load is confirmed good.';

-- Enrolled like every other business table (migration 014 pattern).
alter table feed_load_undo enable row level security;
alter table feed_load_undo force  row level security;
drop policy if exists biz_all on feed_load_undo;
create policy biz_all on feed_load_undo
  for all
  using      (public.current_app_role() in ('admin','manager','office'))
  with check (public.current_app_role() in ('admin','manager','office'));

-- ---------------------------------------------------------------------------
-- The loader, with the snapshot added. Everything else is byte-for-byte the
-- behaviour of 039 — same resolution, same rejects, same conflict rule, same
-- return shape — so this changes what can be undone and nothing about what
-- gets loaded.
--
-- The one structural change: `ok` was a CTE, visible only to its own statement.
-- It becomes a temp table so the snapshot and the merge read the SAME set. If
-- they were computed twice they could differ, and an undo built from a
-- different set than the merge is worse than no undo at all.
-- ---------------------------------------------------------------------------
create or replace function jb_load_feed_upload(p_upload uuid)
returns table (loaded int, rejected int)
language plpgsql
as $$
declare
  v_retailer retailer_type;
  v_loaded   int := 0;
  v_rejected int := 0;
begin
  select retailer into v_retailer from feed_uploads where id = p_upload;
  if v_retailer is null then
    raise exception 'unknown upload %', p_upload;
  end if;

  delete from feed_rejects where upload_id = p_upload;

  create temporary table _res on commit drop as
  with s as (
    select g.*,
           st.id as store_id,
           pr.product_id,
           pr.n_products,
           pr.names
    from feed_staging g
    left join stores st
      on st.retailer = v_retailer
     and st.active
     and public.jb_norm_code_safe(st.supplier_code) = g.location
    left join lateral (
      select (array_agg(p.id order by p.id))[1]        as product_id,
             count(*)::int                             as n_products,
             string_agg(p.name, ' / ' order by p.name) as names
      from products p
      where p.active
        and public.jb_norm_code_safe(
              case v_retailer
                when 'coles'       then p.coles_code
                when 'woolworths'  then p.woolworths_code
                when 'harris_farm' then p.harris_farm_code
                else null
              end
            ) = g.sell_item
    ) pr on true
    where g.upload_id = p_upload
  )
  select * from s;

  insert into feed_rejects (upload_id, row_no, reason, raw)
  select p_upload,
         r.row_no,
         case
           when r.store_id is null and r.product_id is null then
             format('store code %s and product code %s are both unknown to us', r.location, r.sell_item)
           when r.store_id is null then
             format('store code %s is not on any active %s store', r.location, v_retailer)
           when r.product_id is null then
             format('product code %s is not on any active product', r.sell_item)
           else
             format('product code %s is ambiguous — it is on %s products (%s). Someone has to say which one Coles means before this row can load.',
                    r.sell_item, r.n_products, r.names)
         end,
         jsonb_build_object('sale_date', r.sale_date, 'location', r.location,
                            'sell_item', r.sell_item, 'sales_qty', r.sales_qty)
  from _res r
  where r.store_id is null or r.product_id is null or r.n_products > 1;
  get diagnostics v_rejected = row_count;

  -- The rows that will land, materialised once so the snapshot below and the
  -- merge that follows are provably the same set.
  create temporary table _ok on commit drop as
  select r.store_id, r.product_id, r.sale_date,
         sum(r.sales_qty)::int          as units_sold,
         nullif(sum(r.invoice_cost), 0) as invoice_cost
  from _res r
  where r.store_id is not null and r.product_id is not null and r.n_products = 1
  group by 1, 2, 3;

  -- SNAPSHOT FIRST. Before a single row of sales_daily changes.
  delete from feed_load_undo where upload_id = p_upload;
  insert into feed_load_undo
    (upload_id, store_id, product_id, sale_date, existed,
     prior_units_sold, prior_source, prior_invoice_cost)
  select p_upload, k.store_id, k.product_id, k.sale_date,
         (sd.store_id is not null),
         sd.units_sold, sd.source, sd.invoice_cost
    from _ok k
    left join sales_daily sd
      on sd.store_id   = k.store_id
     and sd.product_id = k.product_id
     and sd.sale_date  = k.sale_date;

  insert into sales_daily (store_id, product_id, sale_date, units_sold, source, invoice_cost)
  select store_id, product_id, sale_date, units_sold, v_retailer, invoice_cost
  from _ok
  on conflict (store_id, product_id, sale_date) do update
     set units_sold   = excluded.units_sold,
         source       = excluded.source,
         invoice_cost = coalesce(excluded.invoice_cost, sales_daily.invoice_cost),
         loaded_at    = now();
  get diagnostics v_loaded = row_count;

  update feed_uploads u
     set rows_loaded   = v_loaded,
         rows_rejected = (select count(*) from feed_rejects fr where fr.upload_id = p_upload),
         status        = 'loaded'
   where u.id = p_upload;

  return query select v_loaded, v_rejected;
end $$;

-- ---------------------------------------------------------------------------
-- Put it back exactly as it was.
--
-- Rows that existed are restored to their previous values. Rows that did not
-- exist are deleted. Both halves matter: an undo that only restores leaves the
-- new rows behind, which is a different wrong state rather than the old one.
--
-- Refuses on an upload that was never loaded, so a mis-typed id cannot quietly
-- do nothing and report success.
-- ---------------------------------------------------------------------------
create or replace function jb_undo_feed_upload(p_upload uuid)
returns table (restored int, removed int)
language plpgsql
as $$
declare
  v_status   text;
  v_restored int := 0;
  v_removed  int := 0;
begin
  select status into v_status from feed_uploads where id = p_upload;
  if v_status is null then
    raise exception 'unknown upload %', p_upload;
  end if;
  if not exists (select 1 from feed_load_undo where upload_id = p_upload) then
    raise exception 'no undo snapshot for upload % — it was loaded before migration 044, or has already been undone', p_upload;
  end if;

  update sales_daily sd
     set units_sold   = u.prior_units_sold,
         source       = u.prior_source,
         invoice_cost = u.prior_invoice_cost,
         loaded_at    = now()
    from feed_load_undo u
   where u.upload_id  = p_upload
     and u.existed
     and sd.store_id   = u.store_id
     and sd.product_id = u.product_id
     and sd.sale_date  = u.sale_date;
  get diagnostics v_restored = row_count;

  delete from sales_daily sd
   using feed_load_undo u
   where u.upload_id  = p_upload
     and not u.existed
     and sd.store_id   = u.store_id
     and sd.product_id = u.product_id
     and sd.sale_date  = u.sale_date;
  get diagnostics v_removed = row_count;

  update feed_uploads set status = 'undone' where id = p_upload;
  delete from feed_load_undo where upload_id = p_upload;

  return query select v_restored, v_removed;
end $$;

comment on function jb_undo_feed_upload(uuid) is
  'Reverse a feed load exactly: restore the rows it overwrote, delete the rows it added. Clears the snapshot afterwards, so an undo cannot be run twice against a state it no longer describes.';

-- Verify:
--   select * from feed_load_undo limit 5;
--   -- after a load:
--   select count(*) filter (where existed) as would_restore,
--          count(*) filter (where not existed) as would_delete
--     from feed_load_undo where upload_id = '<id>';
--   -- to reverse:
--   select * from jb_undo_feed_upload('<id>');
