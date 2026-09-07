-- =====================================================================
-- Migration 085: the floor could not read the clock, and the app made one up.
--
-- Found on 7 September, about twenty minutes after the RLS flip went live, by
-- comparing a screenshot of the packing sheet taken BEFORE the flip against one
-- taken after. Same account, same day, same engine run:
--
--     Eastern Suburbs   22 stores · 1,730 units   ->   22 stores · 1,700 units
--     C&M Cafe Bondi    18 items                  ->   16 items
--     bagel lines       5, 5, 4, 4                ->   4, 4, 4, 4
--
-- No error. No log line. Slightly wrong numbers on the sheet the bakery packs
-- from, which is worse than an empty screen, because an empty screen makes
-- somebody phone in and a plausible number does not.
--
-- ---------------------------------------------------------------------
-- THE CHAIN
-- ---------------------------------------------------------------------
-- v_asof is the app's freshness clock -- "how recent is the sales data" -- and
-- it is defined as:
--
--     select coalesce(max(as_of), current_date) as as_of from store_actuals;
--
-- Two things about that line matter.
--
-- FIRST, it reads store_actuals, NOT sales_daily. 002_views.sql defined it over
-- sales_daily; something later redefined it. Migration 078 opened nine tables to
-- the floor and sales_daily was one of them -- store_actuals was not, because
-- nothing anyone looked at said the floor ever touched it. The floor does not,
-- directly. It touches it through this view.
--
-- SECOND, the view carries security_invoker=on, which is correct and is what
-- 079 went and fixed on three views that were missing it. A security-invoker
-- view resolves against the CALLER's policies. So a packer reading v_asof reads
-- store_actuals as a packer -- and a packer had no policy on store_actuals, so
-- it returned zero rows.
--
-- max() of no rows is NULL. COALESCE then substituted CURRENT_DATE.
--
-- So for every driver and every packer, the app believed the sales data was
-- current as of TODAY, when the real answer was 22 August -- sixteen days out.
-- getWeekdayShape() takes the 91 days ending at as_of, so the whole window slid
-- sixteen days, the measured weekday curve changed, and every standing-order
-- quantity was split differently. Which is exactly what the two screenshots
-- showed.
--
-- Measured, not reasoned about. As jbo_app carrying a packer's claims:
--
--     select count(*) from store_actuals   ->  worked (so the GRANT was fine;
--                                              a missing grant raises an error,
--                                              it does not return zero rows)
--     select as_of from v_asof             ->  2026-09-07   (today -- wrong)
--     same, as postgres                    ->  2026-08-22   (right)
--
-- and after this migration, both return 2026-08-22.
--
-- ---------------------------------------------------------------------
-- WHY THREE TABLES AND NOT ONE
-- ---------------------------------------------------------------------
-- store_actuals was the one that showed itself. Patching only that would have
-- been fixing the symptom that happened to be visible.
--
-- The floor's read path goes through exactly two views -- v_asof and
-- v_event_scope, both from getWeekdayShape(). Asking the database which base
-- tables those views depend on, and which of those carry a floor_read policy:
--
--     v_asof         store_actuals         false
--     v_event_scope  events                false
--     v_event_scope  regions               false
--     v_event_scope  replenishment_plans   true
--     v_event_scope  stores                true
--
-- events and regions carry the seasonality multipliers into the same shape
-- calculation, so they would have gone on quietly moving quantities after the
-- obvious one was fixed.
--
-- ---------------------------------------------------------------------
-- WHAT THIS DOES NOT DO
-- ---------------------------------------------------------------------
-- It does not change v_asof. The COALESCE is the reason this was invisible: it
-- turns "I cannot see this table" into "today", which is a plausible answer, so
-- nothing anywhere fails. Returning NULL instead would be more honest, but it
-- is NOT obviously better -- getWeekdayShape would then get no rows, fall to the
-- seed curve, and produce a different wrong answer just as quietly. Fixing that
-- properly means making the callers treat an unknown clock as an error, which is
-- a change to reader code two days before go-live. Recorded here so the next
-- person knows the hazard is understood and deliberately left standing:
--
--     ANY security-invoker view with a COALESCE default over a table the caller
--     cannot read will silently return the default. This one is fixed. Grep for
--     the pattern before trusting another.
--
-- It also adds no grants. jbo_app already holds SELECT on all three -- proven
-- above, because a missing grant raises "permission denied", and what actually
-- happened was a clean zero-row read.
--
-- Additive and idempotent. Three policies, no data changes, no schema changes.
-- Same wording and same shape as migration 078, deliberately, so the two read
-- as one decision rather than two.
-- =====================================================================

begin;

-- The freshness clock. Read by getWeekdayShape() through v_asof.
drop policy if exists floor_read on store_actuals;
create policy floor_read on store_actuals
  for select using ((select public.current_app_role()) in ('driver','packer'));

-- Seasonality. Read by getWeekdayShape() through v_event_scope.
drop policy if exists floor_read on events;
create policy floor_read on events
  for select using ((select public.current_app_role()) in ('driver','packer'));

drop policy if exists floor_read on regions;
create policy floor_read on regions
  for select using ((select public.current_app_role()) in ('driver','packer'));

comment on policy floor_read on store_actuals is
  'The floor never queries this table directly -- it reaches it through v_asof, which is security_invoker. Without this policy the view returns zero rows and its COALESCE substitutes CURRENT_DATE, so every driver and packer believes the sales data is current and every standing-order quantity is split off the wrong 91-day window. Migration 085, 7 September.';

commit;

-- ---------------------------------------------------------------------------
-- VERIFY. Run each block and read the output, not just the row count.
-- ---------------------------------------------------------------------------
--
-- 1. All three now carry floor_read. Expect THREE rows:
--
--   select tablename, policyname from pg_policies
--    where schemaname = 'public' and policyname = 'floor_read'
--      and tablename in ('store_actuals','events','regions')
--    order by tablename;
--
-- 2. The clock agrees. Both must return the SAME date -- 2026-08-22 on the day
--    this was written, whatever max(as_of) is when you run it:
--
--   select 'postgres' as who, (select as_of from v_asof)::text as as_of;
--
--   begin;
--   select set_config('request.jwt.claims',
--            (select json_build_object('sub', id, 'role', 'authenticated')::text
--               from public.users where email = 'packer1@jessesbakery.com.au'), true);
--   set local role jbo_app;
--   select 'jbo_app + packer' as who, (select as_of from v_asof)::text as as_of;
--   rollback;
--
-- 3. No OTHER view on the floor's path has the same gap. Expect NO rows with
--    floor_can_read = false:
--
--   with floor_tables as (
--     select tablename from pg_policies
--      where schemaname = 'public' and policyname = 'floor_read'
--   ),
--   deps as (
--     select distinct v.relname as view_name, t.relname as base_table
--       from pg_depend d
--       join pg_rewrite r on r.oid = d.objid
--       join pg_class  v on v.oid = r.ev_class and v.relkind = 'v'
--       join pg_class  t on t.oid = d.refobjid and t.relkind = 'r'
--      where v.relnamespace = 'public'::regnamespace
--        and t.relnamespace = 'public'::regnamespace
--        and v.relname <> t.relname
--   )
--   select view_name, base_table,
--          (base_table in (select tablename from floor_tables)) as floor_can_read
--     from deps
--    where view_name in ('v_asof','v_event_scope')
--    order by floor_can_read, view_name, base_table;
--
-- 4. The real proof is on screen, not in psql. Sign in as a packer and load the
--    packing sheet: the run totals must match what an admin sees. On 7 September
--    that was Eastern Suburbs 1,730 units and C&M Cafe Bondi at 18 items; wrong
--    was 1,700 and 16.
-- ---------------------------------------------------------------------------
