-- =====================================================================
-- Migration 039: retailer feed uploads — the Coles path first.
--
-- WHY
--
-- Coles' sales reach Jesse as a spreadsheet a person drops into blob storage
-- by hand. Their pipeline reads a fixed cell range out of it. On 3 Aug the
-- report changed shape and that pipeline has read nothing since, while
-- reporting Success — every one of the 259,303 rows in their ETL_Job_Log says
-- 'Success', because the error handler that would say otherwise fails too.
-- 115 stores, 16,849 units a week, 39% of everything Jesse bakes, dark for
-- three weeks under a green light.
--
-- There is no automation to replicate here. If a person is uploading a file by
-- hand, they can upload it to us instead. That is what this migration backs.
--
-- THREE TABLES
--
--   feed_uploads   one row per file, with what we parsed out of it and what
--                  happened. This is the audit trail their system never had.
--   feed_staging   the parsed rows, pre-resolution, keyed to the upload.
--   feed_rejects   every row we could NOT resolve, with a reason and its row
--                  number in the sheet. Nothing is ever dropped silently.
--
-- AND ONE FUNCTION, jb_load_feed_upload(), which resolves codes to our own
-- store and product IDs and merges into sales_daily. Its contract is that a
-- row either loads or appears in feed_rejects. There is no third outcome.
--
-- Additive. Nothing existing is altered. Safe to re-run.
-- =====================================================================

create table if not exists feed_uploads (
  id             uuid primary key default gen_random_uuid(),
  retailer       retailer_type not null,
  filename       text not null,
  -- What the parser bound itself to. On screen after every upload, because a
  -- mis-mapped column that still "works" is the dangerous kind of wrong.
  sheet_name     text,
  header_row     int,
  column_map     jsonb,
  period_from    date,
  period_to      date,
  rows_read      int not null default 0,
  rows_loaded    int not null default 0,
  rows_rejected  int not null default 0,
  status         text not null default 'parsed',   -- parsed | loaded | failed
  error          text,
  uploaded_by    uuid,
  uploaded_at    timestamptz not null default now()
);
create index if not exists feed_uploads_retailer_idx on feed_uploads (retailer, uploaded_at desc);

create table if not exists feed_staging (
  upload_id    uuid not null references feed_uploads(id) on delete cascade,
  row_no       int  not null,
  sale_date    date not null,
  -- Codes as the PARSER normalised them: digits only, leading zeros stripped.
  -- Our stores.supplier_code is zero-padded text ('0819' = Coles Lake Haven)
  -- and the new report sends Location as a number (819). Compared naively that
  -- one store contributes nothing, silently — a feed that runs, succeeds, and
  -- drops a store. Both sides are reduced to the same canonical form below.
  location     text not null,
  sell_item    text not null,
  sales_qty    int  not null,
  waste_qty    numeric,
  invoice_cost numeric(12,4),
  primary key (upload_id, row_no)
);

create table if not exists feed_rejects (
  upload_id  uuid not null references feed_uploads(id) on delete cascade,
  row_no     int  not null,
  reason     text not null,
  raw        jsonb,
  primary key (upload_id, row_no)
);

comment on table feed_uploads is
  'One row per retailer report uploaded. The audit trail the legacy ADF pipeline never had: what file, what we found in it, how many rows landed, how many did not.';
comment on table feed_rejects is
  'Rows that could not be resolved to a store and product, with the reason and the row number in the sheet. A row either loads or lands here — never neither.';

-- ---------------------------------------------------------------------------
-- Same canonical form as the parser's normaliseCode(): digits only, leading
-- zeros stripped, anything else uppercased. Immutable so it can be indexed.
-- ---------------------------------------------------------------------------
-- ONE function, not two calling each other, and schema-qualified.
--
-- The first cut split this into jb_norm_code() plus a jb_norm_code_safe()
-- wrapper. That applied cleanly on a local Postgres and failed on Supabase:
-- building an index on the expression makes the planner INLINE the SQL
-- function, and inlining re-resolves the inner call against whatever
-- search_path is in force at that moment — which is not necessarily the one
-- that was in force at CREATE time. "function jb_norm_code(text) does not
-- exist", on a function that plainly does.
--
-- A single self-contained body cannot hit that, so there is nothing to
-- re-resolve. Cheaper than reasoning about search_path, and it reads better.
create or replace function public.jb_norm_code_safe(v text)
returns text
language sql
immutable
parallel safe
returns null on null input
as $$
  select case
           -- '0819' -> '819'; but a code that is all zeros must not become '',
           -- so it collapses to a single '0'.
           when btrim(v) = ''            then null
           when btrim(v) ~ '^0+$'        then '0'
           when btrim(v) ~ '^[0-9]+$'    then ltrim(btrim(v), '0')
           else upper(btrim(v))
         end
$$;

comment on function public.jb_norm_code_safe(text) is
  'Canonical form for a retailer code: digits only, leading zeros stripped, anything else uppercased. Our stores.supplier_code is zero-padded text (0819) and the retailers now send Location as a number (819) — without this, that store silently contributes nothing.';

drop function if exists public.jb_norm_code(text);

create index if not exists stores_norm_supplier_code_idx
  on stores (retailer, public.jb_norm_code_safe(supplier_code));
create index if not exists products_norm_coles_code_idx
  on products (public.jb_norm_code_safe(coles_code));

-- ---------------------------------------------------------------------------
-- The load. Resolve, reject what won't resolve, merge the rest.
--
-- The ambiguity guard is the important part. products.coles_code 3451243 sits
-- on BOTH 'CROISSANTS - ALMOND' and 'CROISSANTS - CHOCOLATE'. A plain join on
-- that code returns two rows per source row and DOUBLES the units — silent
-- data corruption that looks like growth. So an ambiguous code is rejected
-- with the names it collides with, and a human decides.
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
    raise exception 'No such upload: %', p_upload;
  end if;

  -- Re-runnable: clear any previous verdict for this upload.
  delete from feed_rejects where upload_id = p_upload;

  -- Resolve once, reuse for both the reject pass and the merge.
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
      -- (array_agg)[1] rather than min(): Postgres has no min(uuid). Only ever
      -- read when n_products = 1, so which element it picks cannot matter — an
      -- ambiguous code is rejected below, never resolved to "the first one".
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

  -- Everything that will not load, with a reason a person can act on.
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

  -- The rest lands. Same conflict rule as the 24 Aug historical load, so an
  -- uploaded day and a back-filled day agree rather than double up.
  with ok as (
    select r.store_id, r.product_id, r.sale_date,
           sum(r.sales_qty)::int                         as units_sold,
           nullif(sum(r.invoice_cost), 0)                as invoice_cost
    from _res r
    where r.store_id is not null and r.product_id is not null and r.n_products = 1
    group by 1, 2, 3
  )
  insert into sales_daily (store_id, product_id, sale_date, units_sold, source, invoice_cost)
  select store_id, product_id, sale_date, units_sold, v_retailer, invoice_cost
  from ok
  on conflict (store_id, product_id, sale_date) do update
     set units_sold   = excluded.units_sold,
         source       = excluded.source,
         invoice_cost = coalesce(excluded.invoice_cost, sales_daily.invoice_cost),
         loaded_at    = now();
  get diagnostics v_loaded = row_count;

  -- Counted from feed_rejects rather than added up, so the number on the audit
  -- row and the number of rows a person can actually open are the same number.
  -- (The route writes the parser's own rejects into the same table first.)
  update feed_uploads u
     set rows_loaded   = v_loaded,
         rows_rejected = (select count(*) from feed_rejects fr where fr.upload_id = p_upload),
         status        = 'loaded'
   where u.id = p_upload;

  return query select v_loaded, v_rejected;
end $$;

comment on function jb_load_feed_upload(uuid) is
  'Resolve a staged retailer upload onto our own store and product IDs and merge into sales_daily. Every source row either loads or appears in feed_rejects with a reason — there is no silent drop, which is the failure mode this whole path exists to remove.';

-- ---------------------------------------------------------------------------
-- Feed health: the alert Fred asked for. If sales_as_of stops moving for a
-- retailer, someone hears about it. Coles died on 4 Aug and nobody knew for
-- three weeks because the only monitor could not report a failure.
-- ---------------------------------------------------------------------------
create or replace view v_feed_health as
  with a as (select as_of from v_asof),
  last as (
    select source::text as retailer, max(sale_date) as last_sale
    from sales_daily group by 1
  )
  select l.retailer,
         l.last_sale,
         ((select as_of from a)::date - l.last_sale) as days_behind,
         case
           when ((select as_of from a)::date - l.last_sale) <= 2 then 'ok'
           when ((select as_of from a)::date - l.last_sale) <= 5 then 'late'
           else 'stopped'
         end as status,
         (select max(uploaded_at) from feed_uploads u
           where u.retailer::text = l.retailer and u.status = 'loaded') as last_upload
  from last l;

comment on view v_feed_health is
  'Per-retailer freshness. days_behind is measured against v_asof, the same anchor every other figure uses. status stopped = this feed has died and every number for those stores is stale.';

-- ---------------------------------------------------------------------------
-- RLS. Migration 014 installs a coverage guard that fails if any public table
-- is left without it, so these three are enrolled here on the same pattern:
-- business roles get full access, nobody else gets anything.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['feed_uploads','feed_staging','feed_rejects'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
    execute format('drop policy if exists biz_all on %I', t);
    execute format($p$
      create policy biz_all on %I
        for all
        using      (public.current_app_role() in ('admin','manager','office'))
        with check (public.current_app_role() in ('admin','manager','office'))
    $p$, t);
  end loop;
end $$;

-- Verify:
--   select * from v_feed_health order by days_behind desc;
--   select id, filename, rows_read, rows_loaded, rows_rejected, status
--     from feed_uploads order by uploaded_at desc limit 5;
--   select row_no, reason from feed_rejects where upload_id = '<id>' limit 20;
