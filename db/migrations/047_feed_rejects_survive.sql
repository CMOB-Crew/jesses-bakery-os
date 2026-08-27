-- =====================================================================
-- Migration 047: the Coles upload deletes its own reject list, then reports
-- that nothing was rejected.
--
-- THIS ONE HAS TO LAND BEFORE ANY COLES FILE IS LOADED.
--
-- ---------------------------------------------------------------------
-- DEFECT 1 — silent data loss, and it reports success
-- ---------------------------------------------------------------------
-- app/api/feeds/coles/route.ts writes the PARSER's rejects into feed_rejects,
-- then calls jb_load_feed_upload. That procedure's first statement is:
--
--     delete from feed_rejects where upload_id = p_upload;
--
-- Parser rejects were never written to feed_staging, so nothing re-derives
-- them. They are simply gone. rows_rejected is then recounted from what
-- survived — the loader's own rejects only.
--
-- The concrete case is not exotic. lib/feeds/coles.ts explicitly handles a Day
-- cell reading "n/a" and a Sales Qty reading "--", and rejects those rows with
-- a reason. Upload a Coles file containing one, and:
--
--   * the row never reaches sales_daily
--   * its reason is deleted before anyone can read it
--   * the Feeds page prints  Not loaded: 0
--
-- That store's sell-through and waste are quietly understated forever, and the
-- one page built to prove nothing is dropped silently is the page that lies
-- about it. It is Coles' own ETL_Job_Log reporting Success on 259,303 rows it
-- never wrote, rebuilt by us, on the screen we made to replace it.
--
-- FIX: feed_rejects learns WHO wrote each row. The loader clears only its own,
-- so re-running a load is still idempotent, and the parser's verdicts survive.
--
-- ---------------------------------------------------------------------
-- DEFECT 2 — Read, Loaded and Not loaded cannot add up
-- ---------------------------------------------------------------------
-- The Feeds page shows three columns under a page whose stated contract is "a
-- row either loads or comes back with a reason". They are measured in two
-- different units:
--
--   rows_read    counts SOURCE rows
--   rows_loaded  was `get diagnostics row_count` after an
--                `insert ... on conflict` over `group by store, product, date`
--                — so it counts MERGED KEYS, not rows
--
-- A Coles file has several rows per store per product per day. So Read minus
-- Not loaded never equalled Loaded, and Simona would see a few hundred rows
-- unaccounted for on a normal daily file.
--
-- FIX: rows_loaded becomes the count of SOURCE rows that resolved, so
-- Read = Loaded + Not loaded, exactly. The merged-key count is still useful
-- (it is what actually hit sales_daily) so it gets its own column rather than
-- being thrown away.
--
-- Everything else in the loader is 044's body, unchanged — same resolution,
-- same reject reasons, same conflict rule, same undo snapshot, same return
-- shape. Idempotent. Safe to re-run.
-- =====================================================================

\set ON_ERROR_STOP on

alter table feed_rejects
  add column if not exists source text not null default 'loader';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'feed_rejects_source_ck') then
    alter table feed_rejects
      add constraint feed_rejects_source_ck check (source in ('parser','loader'));
  end if;
end $$;

comment on column feed_rejects.source is
  'Who rejected this row: ''parser'' (the file itself was unreadable at that row — bad date, non-numeric quantity) or ''loader'' (readable, but the store or product code resolved to nothing). The loader clears only its OWN rows before a re-run, because before 047 it deleted the parser''s too and then reported zero rejects.';

alter table feed_uploads
  add column if not exists rows_merged int;

comment on column feed_uploads.rows_merged is
  'Distinct (store, product, date) keys written to sales_daily. rows_loaded counts SOURCE rows so that rows_read = rows_loaded + rows_rejected; a daily file carries several source rows per key, which is why the two differ and why both are worth keeping.';

-- ---------------------------------------------------------------------------
-- 044's loader, with three changes and nothing else:
--   1. the reject delete is scoped to source = 'loader'
--   2. its own rejects are written with source = 'loader'
--   3. rows_loaded counts source rows; merged keys go to rows_merged
-- ---------------------------------------------------------------------------
create or replace function jb_load_feed_upload(p_upload uuid)
returns table (loaded int, rejected int)
language plpgsql
as $$
declare
  v_retailer retailer_type;
  v_loaded   int := 0;
  v_merged   int := 0;
  v_rejected int := 0;
begin
  select retailer into v_retailer from feed_uploads where id = p_upload;
  if v_retailer is null then
    raise exception 'unknown upload %', p_upload;
  end if;

  -- ONLY ours. The parser's verdicts were written before this call and are the
  -- only record that those rows existed at all.
  delete from feed_rejects where upload_id = p_upload and source = 'loader';

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

  insert into feed_rejects (upload_id, row_no, reason, raw, source)
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
                            'sell_item', r.sell_item, 'sales_qty', r.sales_qty),
         'loader'
  from _res r
  where r.store_id is null or r.product_id is null or r.n_products > 1
  on conflict (upload_id, row_no) do nothing;

  -- Every reject on this upload, whoever found it. The parser's are included
  -- because they are real rows that did not load.
  select count(*)::int into v_rejected from feed_rejects where upload_id = p_upload;

  -- SOURCE rows that resolved. This is the number that makes
  -- read = loaded + rejected true.
  select count(*)::int into v_loaded
    from _res r
   where r.store_id is not null and r.product_id is not null and r.n_products = 1;

  create temporary table _ok on commit drop as
  select r.store_id, r.product_id, r.sale_date,
         sum(r.sales_qty)::int          as units_sold,
         nullif(sum(r.invoice_cost), 0) as invoice_cost
  from _res r
  where r.store_id is not null and r.product_id is not null and r.n_products = 1
  group by 1, 2, 3;

  -- SNAPSHOT FIRST (044). Before a single row of sales_daily changes.
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
  get diagnostics v_merged = row_count;

  update feed_uploads u
     set rows_loaded   = v_loaded,
         rows_merged   = v_merged,
         rows_rejected = v_rejected,
         status        = 'loaded'
   where u.id = p_upload;

  return query select v_loaded, v_rejected;
end $$;

comment on function jb_load_feed_upload(uuid) is
  'Resolve a staged retailer upload to store and product ids and merge it into sales_daily, snapshotting the prior state first so jb_undo_feed_upload can reverse it. Clears only its OWN rejects (source = loader) — before 047 it deleted the parser''s as well and then reported zero rejected. Returns SOURCE rows loaded and total rows rejected, so read = loaded + rejected holds.';

-- Verify:
--   select source, count(*) from feed_rejects group by 1;
--   -- after a load, these three must reconcile exactly:
--   select filename, rows_read, rows_loaded, rows_rejected, rows_merged,
--          (rows_read = rows_loaded + rows_rejected) as adds_up
--     from feed_uploads order by uploaded_at desc limit 5;
