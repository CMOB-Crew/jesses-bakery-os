-- =====================================================================
-- 089  The engine's source code did not exist in this repository
--
-- WHAT WAS WRONG
--
-- Migrations 003 and 004 were never committed. Four later migrations --
-- 057, 062, 064, 081 and 083 -- do not contain the engine either: they
-- patch it by reading pg_get_functiondef() out of the RUNNING database,
-- string-replacing a fragment, and executing the result.
--
-- That works, and it is why those changes were safe at the time. But the
-- consequence compounded quietly: after the first one, the only complete
-- copy of jb_plan_day and jb_run_engine in existence was inside Postgres.
-- Not in this repo, not in a backup of this repo, nowhere a person could
-- read. Lose the database and the forecasting engine -- the thing the
-- entire build exists for -- could not be rebuilt from source.
--
-- A migration folder that cannot reproduce the database is not a
-- migration folder. It is a changelog.
--
-- WHAT THIS IS
--
-- Every jb_* routine, dumped from production on 9 September 2026 with
-- pg_get_functiondef() and committed verbatim. Fourteen of them:
--
--   jb_asof                  jb_norm_code_safe
--   jb_check_run_budget      jb_plan_day            <- the engine
--   jb_days_sorted           jb_rebuild_store_reco
--   jb_engine_health         jb_run_engine          <- the nightly job
--   jb_engine_stale_nights   jb_status
--   jb_engine_z              jb_undo_feed_upload
--   jb_is_admin              jb_load_feed_upload
--
-- Verbatim matters. This is not a tidied-up or re-typed version: it is
-- the exact text Postgres holds, including every comment those in-place
-- patches carried along with them. Re-typing it would have produced
-- something that looked right and drifted somewhere invisible.
--
-- APPLYING THIS CHANGES NOTHING. Each statement replaces a routine with
-- what is already there, byte for byte. Its value is entirely that a
-- fresh database built from db/migrations/ now ends up with the same
-- engine as production, instead of an engine several patches out of date.
--
-- It also captures 088, which is in this repo, and everything from 057
-- through 083, which is not.
--
-- HOW TO KEEP IT TRUE
--
-- Do not patch a routine by string-replacing pg_get_functiondef() again.
-- If a function needs changing, paste its current source into a new
-- migration, edit it there, and let the migration be the source. The
-- convenience of an in-place patch is one afternoon; this was three
-- weeks of the repo quietly not describing the system.
-- =====================================================================

-- ------------------------------------------------------------------
-- jb_asof()
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jb_asof()
 RETURNS date
 LANGUAGE sql
 STABLE
AS $function$ select as_of from v_asof $function$;

-- ------------------------------------------------------------------
-- jb_check_run_budget()
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jb_check_run_budget()
 RETURNS void
 LANGUAGE plpgsql
AS $function$
declare
  v_ms int;
begin
  select case
           when current_setting('statement_timeout') in ('0', '') then 2147483647
           else extract(epoch from current_setting('statement_timeout')::interval)::int * 1000
         end
    into v_ms;

  if v_ms < 30000 then
    raise warning 'jb_run_engine: statement_timeout is % — a seven-day run measured 7 seconds over 9,154 rows, so this will probably still finish, but there is little headroom. For a manual run:  set statement_timeout = ''20min'';  first.',
      current_setting('statement_timeout');
  end if;
end
$function$;

-- ------------------------------------------------------------------
-- jb_days_sorted(d weekday[])
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jb_days_sorted(d weekday[])
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$ select coalesce(array_to_string(array(select unnest(d)::text order by 1), ','), '') $function$;

-- ------------------------------------------------------------------
-- jb_engine_health()
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jb_engine_health()
 RETURNS TABLE(last_successful_run timestamp with time zone, last_attempt timestamp with time zone, last_attempt_status text, last_attempt_message text, days_since_success integer, status text)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public', 'cron', 'pg_temp'
AS $function$
with ours as (
  select max(finished_at) filter (where status like 'ok%') as last_ok
    from engine_runs
),
theirs as (
  select max(start_time) filter (where status = 'succeeded') as last_ok,
         max(start_time)                                     as last_attempt,
         (array_agg(status order by start_time desc))[1]     as last_status,
         (array_agg(coalesce(return_message,'') order by start_time desc))[1] as last_message
    from cron.job_run_details d
    join cron.job j on j.jobid = d.jobid
   where j.jobname = 'jb-nightly-engine'
),
best as (
  select greatest(coalesce(ours.last_ok,   'epoch'::timestamptz),
                  coalesce(theirs.last_ok, 'epoch'::timestamptz)) as last_ok,
         theirs.last_attempt, theirs.last_status, theirs.last_message
    from ours, theirs
)
select
  last_ok                                     as last_successful_run,
  last_attempt                                as last_attempt,
  last_status                                 as last_attempt_status,
  left(last_message, 200)                     as last_attempt_message,
  -- CALENDAR days in Sydney, not rounded fractional days. 0 = ran today.
  -- The old form said 1 at lunchtime on a morning the engine ran perfectly.
  ((now() at time zone 'Australia/Sydney')::date
     - (last_ok at time zone 'Australia/Sydney')::date)::int as days_since_success,
  -- Unchanged from 045. Hours, not days, because the job is on a 24h cycle and
  -- "more than 26 hours since a success" is the precise statement of a missed
  -- night. A day counter cannot say that as well.
  case
    when last_ok < now() - interval '36 hours' then 'stopped'
    when last_ok < now() - interval '26 hours' then 'late'
    else 'ok'
  end                                         as status
from best;
$function$;

-- ------------------------------------------------------------------
-- jb_engine_stale_nights()
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jb_engine_stale_nights()
 RETURNS integer
 LANGUAGE sql
 STABLE
AS $function$
  with ordered as (
    select night, sales_as_of,
           row_number() over (order by night desc) as n
      from v_engine_nights
  ),
  newest as (select sales_as_of from ordered where n = 1)
  -- Consecutive most-recent NIGHTS whose standing plan used the newest
  -- sales_as_of. Counting stops at the first night that used anything else.
  select coalesce((
    select count(*)::int
      from ordered o, newest w
     where o.sales_as_of = w.sales_as_of
       and o.n < coalesce((select min(n) from ordered o2, newest w2
                            where o2.sales_as_of <> w2.sales_as_of), 2147483647)
  ), 0);
$function$;

-- ------------------------------------------------------------------
-- jb_engine_z()
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jb_engine_z()
 RETURNS numeric
 LANGUAGE sql
 STABLE
AS $function$
  select coalesce(
    (select sl.z
       from app_settings a
       join engine_service_levels sl on sl.scenario = a.value ->> 'level'
      where a.key = 'service_level'),
    (select z from engine_service_levels where scenario = 'balanced'),
    0.28
  )
$function$;

-- ------------------------------------------------------------------
-- jb_is_admin()
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jb_is_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$ select exists (select 1 from public.users where id = auth.uid() and is_active and role = 'admin'); $function$;

-- ------------------------------------------------------------------
-- jb_load_feed_upload(p_upload uuid)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jb_load_feed_upload(p_upload uuid)
 RETURNS TABLE(loaded integer, rejected integer)
 LANGUAGE plpgsql
AS $function$
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
             format('product code %s is ambiguous — it is on %s products (%s). Someone has to say which one %s means before this row can load.',
                    r.sell_item, r.n_products, r.names, v_retailer)
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
end $function$;

-- ------------------------------------------------------------------
-- jb_norm_code_safe(v text)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jb_norm_code_safe(v text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE STRICT
AS $function$
  select case
           -- '0819' -> '819'; but a code that is all zeros must not become '',
           -- so it collapses to a single '0'.
           when btrim(v) = ''            then null
           when btrim(v) ~ '^0+$'        then '0'
           when btrim(v) ~ '^[0-9]+$'    then ltrim(btrim(v), '0')
           else upper(btrim(v))
         end
$function$;

-- ------------------------------------------------------------------
-- jb_plan_day(p_target date, p_z numeric)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jb_plan_day(p_target date, p_z numeric)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
declare
  n int;
begin
  -- Clear the day first. ON CONFLICT alone updates rows that still qualify but
  -- leaves behind any pair the engine no longer plans — a store whose delivery
  -- days changed, or whose feed went dark — and those stale rows would be read
  -- as a live recommendation.
  delete from replenishment_plans where target_date = p_target;

  with params as (
    select (select coalesce(max(sale_date), current_date) from sales_daily) as as_of
  ),
  p2 as (
    select as_of,
           p_target                                  as target_date,
           extract(dow from p_target)::int           as pg_dow,
           p_z                                      as z
    from params
  ),
  -- The last 6 CALENDAR occurrences of the target weekday.
  --
  -- This used to take the last 6 ROWS from sales_daily matching the weekday. That
  -- is not the same thing, and the difference was costing real money:
  --
  --   sales_daily only holds rows for days something SOLD -- the retailers report
  --   sales, not zeros. Taking the last 6 rows therefore averaged over only the
  --   days that HAD a sale and silently dropped every zero day. Across live stores
  --   the mean came out 1.49x true demand (2.802 vs 1.886 on Sundays). For fast
  --   lines that sell daily it barely mattered; for slow lines it was brutal.
  --   Harris Farm Rose Bay sold ZERO raisin challah on all six recent Sundays, and
  --   the engine still forecast 6.33 -- because with no recency bound it reached
  --   back months to find six Sundays that did have sales.
  --
  -- Building the calendar first and left-joining fixes both faults at once: the
  -- zero days are present and counted, and the window cannot slide into ancient
  -- history. n is now always 6, so the old "single observation -> std = mean*0.25"
  -- branch never fires; with six real observations stddev_pop is meaningful.
  cal as (
    select (p2.target_date - (7 * g.n))::date as d
    from p2, generate_series(1, 6) g(n)
  ),
  -- Which stores are still reporting sales? Computed ONCE as a set, then
  -- joined — not asked per candidate row.
  --
  -- This used to be `exists (select 1 from sales_daily ...)` sitting inside
  -- combos, which is `stores CROSS JOIN products` — 265 x 116 = 30,740 rows,
  -- each firing its own index probe into a 366MB table. On a warm cache that is
  -- survivable; it is not something to depend on. One scan of a seven-day window
  -- answers the same question for every store at once.
  --
  -- The test itself is unchanged: sold something in the seven days to as_of.
  -- Same rule migration 027 uses for the dashboard, so "live" means one thing
  -- across the whole system. Without it the engine sizes the 115 dead Coles
  -- stores off stale history and asks for 24% MORE than they currently receive,
  -- against zero recorded sales.
  live_stores as (
    select distinct sd.store_id
    from sales_daily sd, p2
    where sd.sale_date >  p2.as_of - 7
      and sd.sale_date <= p2.as_of
  ),
  -- Days of stock this drop has to cover: how long until this store's NEXT
  -- delivery. Also computed once per store rather than once per store-product —
  -- it never depended on the product in the first place.
  --
  -- app.py used products.lead_time_days, which is a bake offset, not a coverage
  -- window, so a store delivered Thu + Sat was sent one day of stock to last two.
  cover as (
    select st.id as store_id,
           coalesce((select min(g.n) from generate_series(1,7) g(n)
                      where trim(to_char(p2.target_date + g.n, 'dy'))::weekday
                            = any(st.delivery_days)), 1) as days_to_next
    from stores st, p2
    where st.active
      -- Only plan a store on a day it actually receives a delivery. Without this
      -- the engine recommends for every store every day, roughly doubling the
      -- plan against Jesse's real sheet. (migration 026)
      and trim(to_char(p2.target_date, 'dy'))::weekday = any(st.delivery_days)
  ),
  -- The stores this run will actually plan: live feed AND delivered on the day.
  -- Everything downstream is restricted to these, which is the whole point —
  -- see the note on `pairs`.
  plan_stores as (
    select cv.store_id from cover cv join live_stores ls on ls.store_id = cv.store_id
  ),
  -- Only plan pairs that are actually ranged here: anything that sold at this
  -- store in the six weeks to as_of. No sale in six weeks means delisted or never
  -- ranged, and a zero-filled grid would otherwise invent a plan for it.
  --
  -- Restricted to plan_stores, and that restriction is where the time went. It
  -- used to gather every pair in the network — 2,596 of them — build a six-week
  -- grid over all of it, and compute stats for all of it, before `calc` inner
  -- joined to combos and threw most of it away. Two things fell out of that:
  --
  --   1. The grid's left join to sales_daily was planned as a hash of the ENTIRE
  --      1,155,692-row table, in 32 batches spilling 8,183 blocks to disk. 6.4s.
  --   2. Worse, the planner estimated combos at 116 rows when it is 5,452 — a
  --      47x miss — so it chose a nested loop and re-ran the stats aggregate
  --      once per combos row. 4.8ms x 5,452 loops = 26 of the 27.6 seconds, with
  --      13,345,953 rows discarded by the join filter.
  --
  -- Only ~47 stores are delivered on any given day. Computing stats for the
  -- other 218 was always waste; it just cost nothing measurable until the table
  -- reached a million rows.
  pairs as (
    select distinct sd.store_id, sd.product_id
    from sales_daily sd
    join plan_stores ps on ps.store_id = sd.store_id
    cross join p2
    where sd.sale_date > p2.as_of - 42 and sd.sale_date <= p2.as_of
  ),
  grid as (
    select pr.store_id, pr.product_id, cal.d,
           coalesce(sd.units_sold, 0)::numeric as units
    from pairs pr
    cross join cal
    left join sales_daily sd
      on sd.store_id  = pr.store_id
     and sd.product_id = pr.product_id
     and sd.sale_date  = cal.d
    -- 064: only count a day this store actually FILED.
    --
    -- Without this, cal reaches past the end of the feed and coalesce turns
    -- every unreported date into a hard zero. Measured on 2026-08-28 with
    -- the feed ending 23 Aug: the plan for go-live day ran 20.1% short and
    -- for the Sunday after it 47.9% short, because one and then two of the
    -- six observations were dates on which no store in the network filed
    -- anything at all.
    --
    -- The zero-fill above is still right INSIDE the reporting window: a
    -- store that filed a report and had no sale of a line genuinely sold
    -- zero. This only removes the cells where the store filed NOTHING, which
    -- are unknown rather than zero.
    --
    -- Self-correcting: when the Coles files land, those dates become
    -- reported and re-enter every baseline on the next run, no code change.
    where exists (
      select 1 from sales_daily rp
       where rp.store_id  = pr.store_id
         and rp.sale_date = cal.d
    )
  ),
  -- MATERIALIZED on purpose. Postgres 12+ inlines CTEs by default, which is
  -- what let the planner re-execute this aggregate 5,452 times. Even with the
  -- restriction above, a bad cardinality estimate should cost a rescan of a
  -- small tuplestore, never a fresh aggregation.
  stats as materialized (
    select store_id, product_id,
           count(*)                    as n,
           avg(units)::numeric         as mean,
           stddev_pop(units)::numeric  as std_pop
    from grid
    group by store_id, product_id
  ),
  combos as (
    select st.id  as store_id,
           p.id   as product_id,
           st.shelf_max,
           p.lead_time_days,
           p.min_on_shelf,
           reg.state,
           -- ...but never more days than the bread stays good for. 23 active
           -- stores take one delivery a week; sending them 7 days of stock when
           -- shelf life is 5 would manufacture the exact waste this engine
           -- exists to remove. Those stores are structurally under-served — the
           -- honest answer is to fill to shelf life and flag the gap, not to
           -- pretend a week's bread survives a week.
           least(cv.days_to_next, greatest(1, p.shelf_life_days)) as cover_days
    from stores st
    join cover       cv on cv.store_id = st.id
    join live_stores ls on ls.store_id = st.id
    cross join products p
    cross join p2
    left join regions reg on reg.id = st.region_id
    where st.active and p.active
  ),
  uplift as (
    select c.store_id, c.product_id,
           coalesce((select sum(e.uplift_pct) from events e, p2
                      where p2.target_date between e.start_date and e.end_date
                        and (e.state is null or e.state = c.state::text)
                        and (e.product_ids is null or c.product_id = any(e.product_ids))
                        and (case
                               when e.store_ids is not null then c.store_id = any(e.store_ids)
                               when e.store_id  is not null then c.store_id = e.store_id
                               else true
                             end)), 0)::numeric / 100.0 as up
    from combos c
  ),
  -- ON-HAND. Two guards, both added in 037 after the first completed engine run
  -- on production planned 4,980 units for stores that sell ~12,700 a week.
  --
  -- 1. RECENCY. This had no date bound: `distinct on (store_id, product_id)
  --    order by as_of_date desc` takes the newest ledger row whenever it was
  --    written, so a reading from May is treated as this morning's shelf count.
  --    The engine then does `recommended = forecast + safety - on_hand` and
  --    sends nothing, because as far as it knows the shelf is already full.
  --    Reproduced on the local fixture: a stale 40-unit reading dated 1 May
  --    takes a 15-unit forecast to a recommendation of zero, on every line.
  --
  -- 2. OFF BY DEFAULT. The ledger does not reconcile yet — 23% of store-days
  --    hold more than the shelf physically fits and 72% of the stock sits on
  --    lines that sold nothing all week. We have been telling Simona we won't
  --    switch on-hand on until it's right, while the engine was quietly reading
  --    it the whole time. app_settings.use_on_hand turns it on, and it stays
  --    false until the ledger is trustworthy.
  --
  -- Both guards fail SAFE for a bakery. Assuming an empty shelf over-sends
  -- slightly; assuming a full one on stale data means no bread arrives, and a
  -- shop with no bread is a phone call from Simona, not a waste percentage.
  oh_cfg as (
    select coalesce((select (value ->> 'enabled')::boolean
                       from app_settings where key = 'use_on_hand'), false) as use_oh,
           coalesce((select (value ->> 'max_age_days')::int
                       from app_settings where key = 'use_on_hand'), 2)     as max_age
  ),
  onhand as (
    select distinct on (o.store_id, o.product_id)
           o.store_id, o.product_id, o.closing_on_hand
    from on_hand_ledger o, p2, oh_cfg
    where oh_cfg.use_oh
      and o.as_of_date >  p2.as_of - oh_cfg.max_age
      and o.as_of_date <= p2.as_of
    order by o.store_id, o.product_id, o.as_of_date desc
  ),
  calc as (
    select c.store_id, c.product_id, p2.target_date,
           st.mean, st.n,
           -- app.py: one observation -> std = mean * 0.25
           case when st.n <= 1 then st.mean * 0.25 else st.std_pop end as std,
           greatest(1, c.cover_days)                                   as coverage,
           u.up, coalesce(oh.closing_on_hand, 0)                       as on_hand,
           c.shelf_max, c.min_on_shelf,
           -- 081: this store's own service level when Simona has set one.
           --
           -- The store profile has always let her pick lean / balanced /
           -- service for a single shop, saved it, and told her "the plan
           -- re-sizes each line to match". Nothing read it. These two left
           -- joins are that promise.
           --
           -- LEFT, and coalesced, so a store with no row -- nearly all of
           -- them -- keeps the network z the run was called with, and is
           -- unchanged to the loaf.
           coalesce(esl.z, p2.z)                                 as z
    from combos c
    left join store_settings ss           on ss.store_id  = c.store_id
    left join engine_service_levels esl   on esl.scenario = ss.service_level
    join stats st on st.store_id = c.store_id and st.product_id = c.product_id
    join uplift u on u.store_id = c.store_id and u.product_id = c.product_id
    left join onhand oh on oh.store_id = c.store_id and oh.product_id = c.product_id
    cross join p2
  ),
  final as (
    select store_id, product_id, target_date, mean, on_hand, shelf_max, min_on_shelf,
           round(mean * coverage * (1 + up), 2)                                  as forecast_demand,
           greatest(0, round(mean * coverage * (1 + up) + z * (std * sqrt(coverage))))::int as target_stock
    from calc
  ),
  capped as (
    select f.*,
           greatest(0, f.target_stock - f.on_hand) as raw_rec
    from final f
  ),
  result as (
    select c.*,
           case
             when c.shelf_max is not null and c.raw_rec > c.shelf_max then c.shelf_max
             when c.raw_rec > 0 and c.raw_rec < c.min_on_shelf        then c.min_on_shelf
             else c.raw_rec
           end                                                              as recommended_qty,
           (c.shelf_max is not null and c.raw_rec > c.shelf_max)            as capped_by_shelf
    from capped c
  )
  insert into replenishment_plans
    (store_id, product_id, target_date, forecast_demand, target_stock,
     on_hand_estimate, recommended_qty, capped_by_shelf, reason, model_version)
  select r.store_id, r.product_id, r.target_date, r.forecast_demand, r.target_stock,
         r.on_hand, r.recommended_qty, r.capped_by_shelf,
         'Weekday demand ~' || round(r.mean, 1)
           || '/day. Target ' || r.target_stock
           || ' at the 42nd percentile (waste-aware), on hand ~' || r.on_hand
           || case when r.capped_by_shelf then ' - capped at shelf max.' else '.' end,
         'newsvendor-v3-sql z=' || trim(trailing '.' from trim(trailing '0' from p_z::text))
  from result r
  on conflict (store_id, product_id, target_date) do update set
    forecast_demand  = excluded.forecast_demand,
    target_stock     = excluded.target_stock,
    on_hand_estimate = excluded.on_hand_estimate,
    recommended_qty  = excluded.recommended_qty,
    capped_by_shelf  = excluded.capped_by_shelf,
    reason           = excluded.reason,
    model_version    = excluded.model_version;


  get diagnostics n = row_count;
  return n;
end
$function$;

-- ------------------------------------------------------------------
-- jb_rebuild_store_reco(p_from date, p_to date)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jb_rebuild_store_reco(p_from date, p_to date)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
declare
  n int;
  n_new int;
begin
  drop table if exists _plan_wk;
  create temp table _plan_wk as
  select rp.store_id, rp.product_id, sum(rp.recommended_qty)::int as reco_wk
  from replenishment_plans rp
  where rp.target_date between p_from and p_to
  group by 1, 2;

  -- 088: give a planned line somewhere to land.
  insert into store_reco (store_id, product_id, sold, sent, recommended)
  select pw.store_id, pw.product_id, 0, 0, 0
    from _plan_wk pw
    join stores s on s.id = pw.store_id
   where s.active
  on conflict (store_id, product_id) do nothing;

  get diagnostics n_new = row_count;
  if n_new > 0 then
    raise notice 'jb_rebuild_store_reco: created % store_reco row(s) that did not exist', n_new;
  end if;

  update store_reco r
  set recommended = f.final_reco
  from (
    select r2.store_id,
           r2.product_id,
           case
             when pw.reco_wk is null then r2.sent                    -- no plan: leave it alone
             when r2.sent > 0 and r2.sold >= r2.sent * 0.95
                  then greatest(pw.reco_wk, r2.sold)                 -- RAIL 1
             when r2.sold > 0 and pw.reco_wk = 0
                  then greatest(1, coalesce(p.min_on_shelf, 1))      -- RAIL 2
             else pw.reco_wk
           end as final_reco
    from store_reco r2
    join products p on p.id = r2.product_id
    left join _plan_wk pw on pw.store_id = r2.store_id and pw.product_id = r2.product_id
  ) f
  where f.store_id = r.store_id and f.product_id = r.product_id;

  get diagnostics n = row_count;
  drop table if exists _plan_wk;
  return n;
end
$function$;

-- ------------------------------------------------------------------
-- jb_run_engine(IN p_days integer, IN p_z numeric, IN p_trigger text)
-- ------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE public.jb_run_engine(IN p_days integer DEFAULT 7, IN p_z numeric DEFAULT NULL::numeric, IN p_trigger text DEFAULT 'cron'::text)
 LANGUAGE plpgsql
AS $procedure$
declare
  v_run   bigint;
  v_z     numeric;
  v_from  date := (now() at time zone 'Australia/Sydney')::date;
  v_to    date := (now() at time zone 'Australia/Sydney')::date + (greatest(p_days, 1) - 1);
  d       date;
  v_rows  int;
  v_total int := 0;
  v_days  int := 0;
  v_empty int := 0;
  v_scen  text;
  v_asof  date;
  v_err   text;
begin
  -- Named up front rather than discovered two minutes in — see migration 035.
  -- statement_timeout is armed when the CALL begins, so this cannot fix a
  -- budget that is already too small; it can only say so before the clock runs
  -- out and the error points somewhere misleading.
  perform jb_check_run_budget();

  v_z    := coalesce(p_z, jb_engine_z());
  v_scen := (select a.value ->> 'level' from app_settings a where a.key = 'service_level');
  v_asof := (select max(sale_date) from sales_daily);

  insert into engine_runs (trigger, target_from, target_to, z, scenario, sales_as_of)
  values (p_trigger, v_from, v_to, v_z, v_scen, v_asof)
  returning id into v_run;

  -- Commit the run row BEFORE doing any work. This is a procedure rather than a
  -- function for exactly this reason: if the planning below throws, an
  -- uncommitted log row would roll back with it and a 2am failure would leave
  -- no trace anywhere except cron's own history. The row has to outlive the
  -- work it describes.
  commit;

  -- Inner block with a handler = an implicit savepoint. An error in here undoes
  -- the partial plan and lands in v_err, without touching the committed row
  -- above. Transaction control is not permitted inside a block that has an
  -- exception handler, which is why the commits sit outside it.
  begin
    d := v_from;
    while d <= v_to loop
      v_rows := jb_plan_day(d, v_z);
      if v_rows = 0 then
        -- Legitimate: nobody is delivered that date. Jesse currently delivers
        -- every day of the week, so this should be rare — but a public holiday
        -- or a shrunken run pattern would do it, and aborting the week's plan
        -- over one empty Wednesday is worse than the thing the check guards
        -- against. Count it, name it, carry on.
        v_empty := v_empty + 1;
        raise notice 'jb_run_engine: no stores delivered on %, nothing planned', d;
      else
        v_days  := v_days + 1;
        v_total := v_total + v_rows;
      end if;
      d := d + 1;
    end loop;

    -- The whole window coming back empty is a different animal. That is the
    -- feed having stopped, or a permission check silently swallowing every
    -- write. Fail loudly, because the alternative is the delivery and
    -- production sheets quietly serving last week's plan while looking healthy.
    if v_total = 0 then
      raise exception 'no day in %..% planned anything (sales_as_of %, z %)',
        v_from, v_to, v_asof, v_z;
    end if;

    v_rows := jb_rebuild_store_reco(v_from, v_to);
  exception when others then
    v_err := sqlerrm;
  end;

  if v_err is null then
    update engine_runs
    set finished_at  = clock_timestamp(),   -- 083: not now(); see the note in that migration
        status       = case when v_empty > 0 then 'ok (' || v_empty || ' empty days)' else 'ok' end,
        days_planned = v_days,
        plan_rows    = v_total,
        plan_units   = (select coalesce(sum(recommended_qty), 0)::int
                          from replenishment_plans
                         where target_date between v_from and v_to),
        reco_rows    = v_rows
    where id = v_run;
    commit;
  else
    update engine_runs
    set finished_at = clock_timestamp(), status = 'failed', error = v_err
    where id = v_run;
    commit;
    -- Re-raise so the failure also shows in cron.job_run_details, not only here.
    raise exception 'jb_run_engine run % failed: %', v_run, v_err;
  end if;
end
$procedure$;

-- ------------------------------------------------------------------
-- jb_status(waste_pct numeric, stockout_days integer)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jb_status(waste_pct numeric, stockout_days integer)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select case
    when waste_pct > 30                          then 'red'
    when waste_pct >= 20 or stockout_days >= 1   then 'amber'
    else 'green' end
$function$;

-- ------------------------------------------------------------------
-- jb_undo_feed_upload(p_upload uuid)
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.jb_undo_feed_upload(p_upload uuid)
 RETURNS TABLE(restored integer, removed integer)
 LANGUAGE plpgsql
AS $function$
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
end $function$;

