-- 037 — the engine was subtracting stock the shops don't have
--
-- WHAT HAPPENED
--
-- 036 shipped the event-scope fix, and running it was the first time the
-- current jb_plan_day had ever completed against production (run 1 in
-- engine_runs is still stuck on 'running' from this morning's 2-minute
-- timeout; run 2 is the first that finished). The result:
--
--   before  40,136 units   <- output of the old bash replan
--   after   30,416 units
--
-- Of that 30,416, the 153 stores with no sales feed hold 23,544 — correctly,
-- jb_rebuild_store_reco leaves an unplanned store's `sent` alone, so they keep
-- their standing order. The problem is the other half:
--
--   95 stores that report sales    sell   ~12,700 units / week
--   the engine planned for them            4,980 units / week
--
--   4,473 delivery lines, 4,980 units — about 1.1 units per line. That is not
--   a forecast, that is a floor.
--
-- WHY
--
-- The onhand CTE had no date bound:
--
--     select distinct on (store_id, product_id) store_id, product_id, closing_on_hand
--     from on_hand_ledger
--     order by store_id, product_id, as_of_date desc
--
-- Newest row wins, whenever it was written. The engine then computes
-- `recommended = ceil(forecast + safety - on_hand)`, so any stale reading is
-- subtracted from today's order as though it were this morning's shelf count.
--
-- Reproduced on the local fixture before writing this: inject a 40-unit
-- reading dated 1 May 2026 and a 15-unit forecast becomes a recommendation of
-- ZERO, on every line, silently. No error, no warning, just no bread.
--
-- The second half is worse than the bug. The on-hand ledger does not reconcile
-- — 23% of store-days hold more than the shelf physically fits, 72% of the
-- stock sits on lines that sold nothing all week. That is written down, and the
-- position we have given Simona is that on-hand stays off until it's right.
-- The engine was reading it anyway. The dashboard was honest and the engine
-- wasn't, which is the same shape as the event-scope bug in 036: the words were
-- right and the arithmetic wasn't.
--
-- THE FIX
--
--   1. A recency bound. A reading only counts if it is within
--      app_settings.use_on_hand -> max_age_days (default 2) of the sales as-of
--      date.
--   2. Off by default. app_settings.use_on_hand -> enabled, default false.
--      Turn it on when the ledger reconciles, not before.
--
-- Both fail safe for a bakery. Assuming an empty shelf over-sends a little;
-- assuming a full one on stale data means a shop gets nothing — and a shop with
-- no bread is a phone call, not a waste percentage.
--
-- Everything else in jb_plan_day is byte-for-byte 033 plus the 036 event scope.
-- Idempotent.

-- ------------------------------------------------------------------
-- The switch, explicitly off
-- ------------------------------------------------------------------
insert into app_settings (key, value)
values ('use_on_hand', '{"enabled": false, "max_age_days": 2}'::jsonb)
on conflict (key) do nothing;

comment on table on_hand_ledger is
  'Shelf stock per store-product per day. The engine subtracts this from what it sends, so a stale or wrong row means a shop gets no bread. Gated behind app_settings.use_on_hand (default off) and a recency bound — see migration 037. Do not switch on until the ledger reconciles.';

-- ------------------------------------------------------------------
-- The engine
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
                        and (e.state is null or e.state = c.state::text)
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
-- Close out the run that never finished
-- ------------------------------------------------------------------
-- Run 1 has sat on status 'running' since 02:28 this morning — it is the one
-- the 2-minute statement_timeout killed, and because the CALL was cancelled the
-- procedure never got to write its own failure. v_engine_health would show a run
-- permanently in progress, which is exactly the signal we built that view to
-- give us for real. Anything still 'running' after an hour is dead.

update engine_runs
   set status = 'failed',
       finished_at = coalesce(finished_at, now()),
       error = coalesce(error, 'Cancelled by statement_timeout before the procedure could record its own failure; closed out by migration 037.')
 where status = 'running'
   and started_at < now() - interval '1 hour';

-- ------------------------------------------------------------------
-- Verify
-- ------------------------------------------------------------------
-- Replan, then check the reporting stores are back in the right range:
--
--   set statement_timeout = '20min';
--   call jb_run_engine(7, null, 'manual');
--
--   select w.has_sales_feed, count(distinct r.store_id) as stores,
--          sum(r.recommended) as units
--     from store_reco r left join v_store_week w on w.store_id = r.store_id
--    group by 1 order by 1;
--
-- Expect the has_sales_feed = true row to land near what those stores actually
-- sell (~12,700/wk) rather than the 6,845 it read before this migration. It
-- should come in ABOVE what they sell and BELOW what they are currently sent
-- (19,491) — that gap is the waste the engine exists to trim.
