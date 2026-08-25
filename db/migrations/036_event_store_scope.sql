-- 036 — events must only move the stores they actually apply to
--
-- WHAT WAS WRONG
--
-- The engine's uplift is computed like this (033, `uplift` CTE):
--
--     select sum(e.uplift_pct) from events e
--      where target_date between e.start_date and e.end_date
--        and (e.state is null or e.state = c.state::text)
--
-- State is the ONLY filter. `events.store_id` has existed since 001 and the
-- engine has never read it. So every event with a null state moves every one
-- of the 265 stores, no matter what the row says it applies to.
--
-- The seeded calendar (008) then says, in its own notes:
--
--   Rosh Hashanah        +12%   "~6 Jewish-demographic stores"     11-13 Sep
--   Yom Kippur            -8%   "Jewish-demographic stores"        20-21 Sep
--   Sukkot->Simchat Torah +8%   "~6 Jewish-demographic stores"     25 Sep-4 Oct
--   Forecast heatwave     -6%   "Example only"                     18-19 Sep
--
-- All four have a null state. All four currently apply network-wide, and they
-- SUM — so 28 Sep to 4 Oct the plan carries +8 (Sukkot, meant for six stores)
-- and -30 (spring school holidays, genuinely NSW-wide) for a net -22% across
-- the entire network.
--
-- Go-live is 3 Sept. The first of these fires on the 11th. Nobody would have
-- seen it coming from the UI, because the calendar renders the scope text and
-- the scope text is right — it's the engine that ignores it.
--
-- WHAT THIS CHANGES
--
-- 1. events.store_ids uuid[] — the scope the engine actually reads.
--      null       -> network-wide (or state-wide, if state is set)
--      '{}'       -> applies to NOBODY. This is the safe parking spot for an
--                    event we know is store-specific but whose store list we
--                    haven't been given yet.
--      {a,b,c}    -> exactly those stores.
--    The legacy single `store_id` column still works and is folded in.
--
-- 2. The three Jewish-calendar events are parked on '{}' until Simona names
--    the stores. They are real events with real effects; we simply do not yet
--    know where they land, and applying a challah spike to 265 supermarkets is
--    a worse answer than applying it to none.
--
-- 3. The example heatwave is deleted. It is not data, it was illustration, and
--    illustration does not belong in a table the engine reads.
--
-- 4. jb_plan_day's uplift CTE is replaced to honour the scope.
--
-- Idempotent. Safe to re-run.

-- ------------------------------------------------------------------
-- 1. Scope column
-- ------------------------------------------------------------------
alter table events add column if not exists store_ids uuid[];

comment on column events.store_ids is
  'Stores this event applies to. NULL = every store (subject to `state`). Empty array = no stores — used to park a store-specific event whose store list is not known yet. The engine reads this; do not add a row here for illustration, because every row moves the plan.';

comment on table events is
  'The seasonality calendar the engine plans against. EVERY row in this table changes what the bakery bakes. Rows are additive: two events covering the same day sum their uplifts. Anything that is an example, a demo or a maybe belongs somewhere else.';

-- ------------------------------------------------------------------
-- 2. Park the store-specific events until we have the store list
-- ------------------------------------------------------------------
-- Matched on name, not id, because 008 seeds by name and these rows may have
-- been re-inserted. Only touches rows still unscoped, so a store list added by
-- hand later is never clobbered by a re-run.
update events
   set store_ids = '{}'::uuid[]
 where store_ids is null
   and store_id is null
   and name in ('Rosh Hashanah', 'Yom Kippur', 'Sukkot -> Simchat Torah');

-- ------------------------------------------------------------------
-- 3. Remove the illustration
-- ------------------------------------------------------------------
delete from events
 where name = 'Forecast heatwave'
   and start_date = date '2026-09-18';

-- ------------------------------------------------------------------
-- 4. Teach the engine to read the scope
-- ------------------------------------------------------------------
-- Only the `uplift` CTE changes; everything else in jb_plan_day is byte-for-byte
-- what 033 shipped, including the perf work from the store-planning fix.
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
                        and (e.state is null or e.state = c.state::text)
                        -- The scope the row actually declares. store_ids wins;
                        -- the legacy single store_id is folded in; NULL on both
                        -- still means network-wide, which is right for a real
                        -- network event like Christmas or a public holiday.
                        and (case
                               when e.store_ids is not null then c.store_id = any(e.store_ids)
                               when e.store_id  is not null then c.store_id = e.store_id
                               else true
                             end)), 0)::numeric / 100.0 as up
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

-- ------------------------------------------------------------------
-- Visibility: what is each event actually going to move?
-- ------------------------------------------------------------------
create or replace view v_event_scope as
select e.id,
       e.name,
       e.start_date,
       e.end_date,
       e.uplift_pct,
       e.state,
       case
         when e.store_ids is not null then cardinality(e.store_ids)
         when e.store_id  is not null then 1
         else (select count(*)::int from stores s
                where s.active
                  and (e.state is null
                       or e.state = (select r.state from regions r where r.id = s.region_id)))
       end as stores_affected
from events e;

comment on view v_event_scope is
  'How many stores each calendar event will actually move. A store-specific event showing 0 is parked and waiting for its store list; a supposedly store-specific event showing 265 is mis-scoped and will move the whole network.';

-- Verify:
--   select name, start_date, uplift_pct, stores_affected
--     from v_event_scope order by start_date;
--
-- Expect: Rosh Hashanah / Yom Kippur / Sukkot at 0 (parked),
--         Spring school holidays at the NSW count,
--         Christmas / Easter / Labour Day network-wide,
--         no Forecast heatwave row at all.
--
-- Then replan so the change lands in the current plan:
--   set statement_timeout = '20min';
--   call jb_run_engine(7, null, 'manual');
