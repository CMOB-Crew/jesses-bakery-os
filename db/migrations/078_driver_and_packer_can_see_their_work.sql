-- Migration 078: a driver and a packer can SEE the day they are working.
--
-- Migration 075 fixed half of this and I did not notice the other half until I
-- went looking for it. 075 gave the driver role insert, update and select on
-- daily_run_state so a delivery would save after the AUTH_ENFORCED flip. It
-- said nothing about everything the driver page READS on its way to that
-- save.
--
-- MEASURED against production, 3 September, before writing a line:
--
--   policies in public that mention 'driver' ... 3, all on daily_run_state
--   policies in public that mention 'packer' ... NONE, on any table
--   total policies in public .................. 57
--
-- Every table the driver and packing pages read -- stores, products, runs,
-- replenishment_plans, store_reco, store_product_overrides, store_product_days,
-- store_run_overrides, sales_daily -- carries one policy, biz_all (or
-- biz_read_store_reco), and every one of them reads:
--
--   current_app_role() = any (array['admin','manager','office'])
--
-- So on the morning after the flip:
--
--   * A DRIVER signs in and gets an EMPTY RUN. Not an error, not a warning --
--     every select returns zero rows, so the page renders a run with no stops.
--     075 means they could save a delivery; there would be nothing to save it
--     against. Six phones, six blank screens, at 4am.
--   * A PACKER cannot read or write anything at all. The packing sheet is the
--     one screen the floor uses every single morning and the packer role has
--     no policy anywhere in the database.
--
-- None of this is visible today, for the same reason 075 was invisible: the app
-- still connects as the privileged role, so all 57 policies are dormant. The
-- flip is what turns them on, and it turns them all on at once.
--
-- WHAT THIS GRANTS, AND WHAT IT DELIBERATELY DOES NOT.
--
-- SELECT only, on the nine tables those two screens read. No insert, no update,
-- no delete on any of them. A driver cannot edit a store, a packer cannot
-- change a plan. The only thing either of them writes is their own day's row in
-- daily_run_state, which stays scoped by surface.
--
-- Not scoped to one run, and that is a decision rather than an oversight.
-- Scoping a driver to their own stores needs a link from a user to a run, and
-- there is no such link in the schema -- there are no driver accounts at all
-- yet, so there is nothing to attach one to. The floor sees the day's plan on
-- paper anyway. When accounts exist and a driver is attached to a run, these
-- policies narrow; the shape does not change.
--
-- Permissive policies OR together, so these widen biz_all rather than narrowing
-- it. Admin, manager and office are untouched.
--
-- current_app_role() is wrapped in a scalar subquery, matching 025 and 075:
-- evaluated once per query as an initplan, not once per row. On stores that is
-- 336 rows and on sales_daily it is the whole feed history, so this matters.
--
-- WHAT THIS STILL DOES NOT PROVE. That current_app_role() returns 'driver' for
-- a real signed-in driver, because there are no driver accounts -- public.users
-- holds exactly two rows today, one admin and one manager, and its id is a
-- foreign key to auth.users. The policies are right; the round trip is untested
-- until Simona sends the driver and packer names and email addresses. That is
-- the last thing standing between here and the flip.
--
-- Additive and idempotent.

begin;

-- ---------------------------------------------------------------------------
-- 1. The read set. Nine tables, select only, driver and packer.
-- ---------------------------------------------------------------------------
drop policy if exists floor_read on stores;
create policy floor_read on stores
  for select using ((select public.current_app_role()) in ('driver','packer'));

drop policy if exists floor_read on products;
create policy floor_read on products
  for select using ((select public.current_app_role()) in ('driver','packer'));

drop policy if exists floor_read on runs;
create policy floor_read on runs
  for select using ((select public.current_app_role()) in ('driver','packer'));

drop policy if exists floor_read on replenishment_plans;
create policy floor_read on replenishment_plans
  for select using ((select public.current_app_role()) in ('driver','packer'));

drop policy if exists floor_read on store_reco;
create policy floor_read on store_reco
  for select using ((select public.current_app_role()) in ('driver','packer'));

drop policy if exists floor_read on store_product_overrides;
create policy floor_read on store_product_overrides
  for select using ((select public.current_app_role()) in ('driver','packer'));

drop policy if exists floor_read on store_product_days;
create policy floor_read on store_product_days
  for select using ((select public.current_app_role()) in ('driver','packer'));

drop policy if exists floor_read on store_run_overrides;
create policy floor_read on store_run_overrides
  for select using ((select public.current_app_role()) in ('driver','packer'));

-- sales_daily is read by the packing sheet (getPackingState reads it for the
-- day's actuals, and getWeekdayShape reads it for the weekday multiplier).
drop policy if exists floor_read on sales_daily;
create policy floor_read on sales_daily
  for select using ((select public.current_app_role()) in ('driver','packer'));

-- ---------------------------------------------------------------------------
-- 2. The packer's own day, on daily_run_state.
--
--    Exactly the shape 075 gave the driver, and for the same reasons:
--    scoped to their own surface so a packer cannot read or touch the
--    production, deliveries or driver boards that share this table; insert and
--    update but NO DELETE, because a packing record is evidence of what was
--    sent and removing one is not something the floor should be able to do.
--    SELECT is needed as well as the writes -- the sheet reads today's row back
--    on every load, and without it a packer reloading mid-morning starts again
--    from the top.
-- ---------------------------------------------------------------------------
drop policy if exists packer_run_state_read   on daily_run_state;
drop policy if exists packer_run_state_insert on daily_run_state;
drop policy if exists packer_run_state_update on daily_run_state;

create policy packer_run_state_read on daily_run_state
  for select using ((select public.current_app_role()) = 'packer' and surface = 'packing');

create policy packer_run_state_insert on daily_run_state
  for insert with check ((select public.current_app_role()) = 'packer' and surface = 'packing');

create policy packer_run_state_update on daily_run_state
  for update using      ((select public.current_app_role()) = 'packer' and surface = 'packing')
             with check ((select public.current_app_role()) = 'packer' and surface = 'packing');

commit;

-- Verify -- one row per table, listing which roles can now read it:
--
--   select tablename,
--          string_agg(distinct policyname, ', ' order by policyname) as policies,
--          bool_or(coalesce(qual,'') ilike '%driver%')  as driver_can_read,
--          bool_or(coalesce(qual,'') ilike '%packer%')  as packer_can_read
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('stores','products','runs','replenishment_plans',
--                        'store_reco','store_product_overrides',
--                        'store_product_days','store_run_overrides',
--                        'sales_daily','daily_run_state')
--    group by tablename
--    order by tablename;
--
--   -- expect all ten rows true / true.
