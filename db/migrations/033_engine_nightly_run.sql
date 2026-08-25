-- 033 — the engine runs itself
--
-- Until now the forecast engine was a script on a laptop. The week's plan
-- existed because somebody typed `./27_replan_week.sh 0.28` and waited. Nothing
-- re-ran it. Simona's delivery and production sheets were current only for as
-- long as nobody looked away.
--
-- Two things had to change before it could be automated, and both were bugs
-- rather than plumbing:
--
--   1. THE DATES WERE HARDCODED. 27_replan_week.sh planned
--      2026-08-23..2026-08-29 literally, and 29_rebuild_with_guards.sql
--      aggregated the same fixed window. Run either of them next week and they
--      quietly rebuild last week.
--
--   2. SIMONA'S SERVICE-LEVEL CONTROL WAS DECORATIVE. The Settings page writes
--      app_settings.service_level = {"level":"lean"|"balanced"|"service"} and
--      nothing has ever read it. The z that actually shaped the plan lived in a
--      shell argument. So she could set the dial, see it save, and change
--      nothing. engine_service_levels below is the missing half — the mapping
--      from her word to the engine's number, in the database where both sides
--      can see it.
--
-- What this migration adds:
--   engine_service_levels   scenario -> z, seeded with the values that produced
--                           the current engine_projection panel
--   engine_runs             one row per run: what it planned, how long it took,
--                           and how stale the sales data was at the time
--   jb_engine_z()           resolve today's z from Simona's setting
--   jb_plan_day()           services/forecast/sql/plan_write.sql as a function,
--                           arithmetic byte-identical, psql variables replaced
--                           with parameters
--   jb_rebuild_store_reco() 29_rebuild_with_guards.sql as a function, both
--                           safety rails intact, window now relative
--   jb_run_engine()         the whole nightly job, and the thing cron calls
--
-- Scheduling lives in 034 so this migration is safe to apply anywhere,
-- including environments with no pg_cron.
--
-- RLS NOTE: these run as the scheduling role (postgres), which carries
-- BYPASSRLS on Supabase — verified: `select * from v_store_week` as postgres
-- returns all 265 rows through security_invoker views over force-RLS tables,
-- which it could not do otherwise. jb_run_engine still raises if a day plans
-- zero rows, so an RLS surprise fails loudly into engine_runs instead of
-- silently writing nothing.

-- ------------------------------------------------------------------
-- 0. Two tables production has had all along and this repo never did
-- ------------------------------------------------------------------
-- store_reco and store_actuals exist on the live database but were created by
-- hand, outside the migration set. Migration 018 already turns RLS on for both,
-- which means db/migrations has been referencing tables it never creates: apply
-- these files to an empty database and 018 fails. Found while building a local
-- Postgres to test this migration against — the drift only shows up when you
-- try to stand the schema up from scratch, which nobody had.
--
-- Definitions transcribed from the live tables. `if not exists` throughout, so
-- this is a no-op against production and a repair everywhere else.

create table if not exists store_reco (
  store_id    uuid not null references stores(id)   on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  sold        int not null default 0,
  sent        int not null default 0,
  recommended int not null default 0,
  primary key (store_id, product_id)
);
create index if not exists store_reco_store_idx on store_reco (store_id);

comment on table store_reco is
  'Current-week sent/sold per store-product, plus the engine recommendation folded in by jb_rebuild_store_reco(). This is what the Deliveries and Production sheets read.';

create table if not exists store_actuals (
  store_id uuid primary key references stores(id) on delete cascade,
  sent     int not null default 0,
  sold     int not null default 0,
  as_of    date
);

comment on table store_actuals is
  'Per-store weekly totals as at as_of. v_asof reads max(as_of) here — it is what the whole dashboard means by "this week".';

-- ------------------------------------------------------------------
-- 1. The dial Simona actually turns
-- ------------------------------------------------------------------
create table if not exists engine_service_levels (
  scenario text primary key,
  z        numeric not null,
  label    text    not null,
  ord      int     not null default 0
);

comment on table engine_service_levels is
  'Maps the service level Simona picks on Settings (app_settings.service_level) to the engine z. Higher z = fuller shelves, more waste. Seeded with the three values behind the Overview projection panel.';

insert into engine_service_levels (scenario, z, label, ord) values
  ('lean',     0.18, 'Lean (waste-first)', 1),
  ('balanced', 0.28, 'Balanced',           2),
  ('service',  0.39, 'Service-leaning',    3)
on conflict (scenario) do nothing;

-- ------------------------------------------------------------------
-- 2. Run log — so a 2am failure is visible at 6am
-- ------------------------------------------------------------------
create table if not exists engine_runs (
  id            bigserial primary key,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running',   -- running | ok | failed
  trigger       text not null default 'cron',      -- cron | manual
  target_from   date,
  target_to     date,
  z             numeric,
  scenario      text,
  sales_as_of   date,          -- how fresh the sales data was at run time
  days_planned  int,
  plan_rows     int,
  plan_units    int,
  reco_rows     int,
  error         text
);

create index if not exists engine_runs_started_idx on engine_runs (started_at desc);

comment on table engine_runs is
  'One row per engine run. sales_as_of is the newest sale_date the engine could see — if that stops moving, the feed has stopped and the plan is being recomputed from stale demand.';

-- ------------------------------------------------------------------
-- 3. Resolve today's z from Simona's setting
-- ------------------------------------------------------------------
create or replace function jb_engine_z()
returns numeric
language sql
stable
as $fn$
  select coalesce(
    (select sl.z
       from app_settings a
       join engine_service_levels sl on sl.scenario = a.value ->> 'level'
      where a.key = 'service_level'),
    (select z from engine_service_levels where scenario = 'balanced'),
    0.28
  )
$fn$;

comment on function jb_engine_z() is
  'The z the nightly run uses: Simona''s Settings choice, else balanced, else 0.28. Never null.';

-- ------------------------------------------------------------------
-- 4. One day of plan. Body is plan_write.sql, arithmetic unchanged.
--    :'target' -> p_target,  :z -> p_z,  :'z' -> p_z::text
-- ------------------------------------------------------------------
create or replace function jb_plan_day(p_target date, p_z numeric)
returns int
language plpgsql
as $fn$
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
                        and (e.state is null or e.state = c.state::text)), 0)::numeric / 100.0 as up
    from combos c
  ),
  onhand as (
    select distinct on (store_id, product_id) store_id, product_id, closing_on_hand
    from on_hand_ledger
    order by store_id, product_id, as_of_date desc
  ),
  calc as (
    select c.store_id, c.product_id, p2.target_date,
           st.mean, st.n,
           -- app.py: one observation -> std = mean * 0.25
           case when st.n <= 1 then st.mean * 0.25 else st.std_pop end as std,
           greatest(1, c.cover_days)                                   as coverage,
           u.up, coalesce(oh.closing_on_hand, 0)                       as on_hand,
           c.shelf_max, c.min_on_shelf, p2.z
    from combos c
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
$fn$;

comment on function jb_plan_day(date, numeric) is
  'Plans one target date into replenishment_plans. Set-based port of services/forecast/sql/plan_write.sql — same maths, no psql variables. Deletes the day first so pairs the engine stops planning do not linger.';

-- ------------------------------------------------------------------
-- 5. Rebuild store_reco from the planned window, with both rails.
--    Body is 29_rebuild_with_guards.sql; the window is now a parameter
--    instead of the literal 2026-08-23..2026-08-29 it shipped with.
-- ------------------------------------------------------------------
--
-- THE RAILS, restated because they must survive any future edit here:
--
--   RAIL 1  A line that sold >= 95% of what it received is never planned below
--           what it actually sold. Sold is a CENSORED observation — when a shelf
--           empties we record what went out, not what would have. Observed sales
--           are a FLOOR on demand there, not an estimate of it. Without this the
--           engine trims a sold-out line exactly like a slow one, and every
--           stockout shrinks the next forecast, which causes the next stockout.
--
--   RAIL 2  A line that sold anything at all is never planned to zero. The
--           engine zeroed 18 live lines, including a challah that sold 2 of 2 —
--           a clean sell-out being delisted. min_on_shelf cannot catch these
--           because it only applies once the raw recommendation is above zero.
--
-- Stores the engine could not plan (no live sales feed) carry their current
-- standing order through unchanged. No opinion must read as no change, never as
-- zero — that bug sent 163 stores to zero on 24 Aug, Jesse's Cafe included.

create or replace function jb_rebuild_store_reco(p_from date, p_to date)
returns int
language plpgsql
as $fn$
declare
  n int;
begin
  drop table if exists _plan_wk;
  create temp table _plan_wk as
  select rp.store_id, rp.product_id, sum(rp.recommended_qty)::int as reco_wk
  from replenishment_plans rp
  where rp.target_date between p_from and p_to
  group by 1, 2;

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
$fn$;

comment on function jb_rebuild_store_reco(date, date) is
  'Folds a window of replenishment_plans into store_reco.recommended, applying the sold-out floor (rail 1) and the never-delist floor (rail 2). Stores with no plan keep their standing order.';

-- ------------------------------------------------------------------
-- 6. The nightly job
-- ------------------------------------------------------------------
create or replace procedure jb_run_engine(p_days int default 7,
                                         p_z numeric default null,
                                         p_trigger text default 'cron')
language plpgsql
as $fn$
declare
  v_run   bigint;
  v_z     numeric;
  v_from  date := current_date;
  v_to    date := current_date + (greatest(p_days, 1) - 1);
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
    set finished_at  = now(),
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
    set finished_at = now(), status = 'failed', error = v_err
    where id = v_run;
    commit;
    -- Re-raise so the failure also shows in cron.job_run_details, not only here.
    raise exception 'jb_run_engine run % failed: %', v_run, v_err;
  end if;
end
$fn$;

comment on procedure jb_run_engine(int, numeric, text) is
  'The nightly job: plan today + the next p_days-1 days at the current service level, then fold that window into store_reco. Call it, do not select it. Writes one engine_runs row, committed up front so a failure is still visible afterwards.';

-- ------------------------------------------------------------------
-- 7. RLS — the new tables join the same regime as everything else (014/018)
-- ------------------------------------------------------------------
alter table engine_service_levels enable row level security;
alter table engine_service_levels force  row level security;
drop policy if exists biz_read_engine_service_levels on engine_service_levels;
create policy biz_read_engine_service_levels on engine_service_levels
  for select using ((select current_app_role()) = any (array['admin','manager','office']));

alter table engine_runs enable row level security;
alter table engine_runs force  row level security;
drop policy if exists biz_read_engine_runs on engine_runs;
create policy biz_read_engine_runs on engine_runs
  for select using ((select current_app_role()) = any (array['admin','manager','office']));

grant select on engine_service_levels, engine_runs to jbo_app;

-- Verify:
--   select jb_engine_z();
--   select jb_run_engine(7, null, 'manual');
--   select id, status, started_at, finished_at, sales_as_of, plan_rows, plan_units
--     from engine_runs order by id desc limit 5;
