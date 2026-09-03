-- Migration 071: a driver can record a delivery.
--
-- daily_run_state got its RLS in 018, whose biz_all policy admits admin,
-- manager and office only. When the driver app started writing to that table
-- (53455c3), nobody added the driver role. So the moment DATABASE_URL is
-- repointed to jbo_app and AUTH_ENFORCED=1 -- step 7 of the activation, still
-- outstanding -- every delivery a driver taps is refused by the database and
-- they cannot record a single drop.
--
-- It is invisible today only because the app still connects as the privileged
-- role, so every policy in 014 and 018 is dormant. Testing a delivery right now
-- proves nothing about what happens after the flip.
--
-- SCOPED TO surface = 'driver' in both directions. daily_run_state is a generic
-- (surface, day) store: the production, deliveries and packing boards live in
-- the same table, and a driver has no business reading or writing those.
--
-- INSERT and UPDATE, deliberately NO DELETE -- the same reasoning 014 used to
-- give delivery_photos insert-only: a record of a drop is evidence, and a driver
-- must not be able to remove evidence of one they missed. Admin, manager and
-- office keep full access through biz_all.
--
-- SELECT is needed too, not just the writes: the app reads today's row back on
-- every page load so a driver reopening the phone mid-run picks up where they
-- left off. Without it the read returns nothing and the run restarts from the
-- top of the list.
--
-- Additive and idempotent. Policies are permissive, so these OR with biz_all
-- rather than narrowing it. current_app_role() is wrapped in a scalar subquery
-- to match 025 (initplan: evaluate once per query, not once per row).

drop policy if exists driver_run_state_read   on daily_run_state;
drop policy if exists driver_run_state_insert on daily_run_state;
drop policy if exists driver_run_state_update on daily_run_state;

create policy driver_run_state_read on daily_run_state
  for select using ((select public.current_app_role()) = 'driver' and surface = 'driver');

create policy driver_run_state_insert on daily_run_state
  for insert with check ((select public.current_app_role()) = 'driver' and surface = 'driver');

create policy driver_run_state_update on daily_run_state
  for update using      ((select public.current_app_role()) = 'driver' and surface = 'driver')
             with check ((select public.current_app_role()) = 'driver' and surface = 'driver');

-- Verify:
--   select policyname, cmd from pg_policies
--    where tablename = 'daily_run_state' order by policyname;
--   -- expect biz_all plus the three driver_run_state_* above.
