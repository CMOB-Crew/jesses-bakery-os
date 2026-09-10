-- 092_a_driver_could_not_write_what_they_delivered.sql
--
-- Two commits this week gave the driver app writes it never had: 25c926d
-- records what was actually delivered into delivery_items, and the wastage
-- commit alongside this migration records what was pulled off the shelf into
-- wastage. Both work today. Both stop working the moment AUTH_ENFORCED is
-- turned on, and neither would have looked broken before then.
--
-- The policies as they stand:
--
--   deliveries        driver_read_deliveries        select        (014)
--                     driver_deliveries_insert      insert        (080)
--                     driver_deliveries_update      update        (080)
--   delivery_photos   driver_photos_insert/read     insert,select (014)
--                     driver_photos_update          update        (080)
--   delivery_items    driver_read_delivery_items    SELECT ONLY   (014, 025)
--   wastage           -- nothing at all --
--
-- So a driver may create the delivery row and attach the photograph and the
-- signature, and may not write a single line of what was in the van or a
-- single unit of what came off the shelf. 080 added the header and forgot the
-- body, because at the time nothing wrote the body.
--
-- This is the same shape as the bug 083 fixed: RLS returning no rows rather
-- than an error means a missing policy ships looking like it works, and every
-- test passes because whoever ran it was signed in as an admin. On INSERT it
-- is louder -- a row-level security violation, which the action catches and
-- turns into "Could not record what was delivered" -- but it is still a
-- failure that appears only after the flip, on a phone, at a store, with the
-- driver standing there.
--
-- WHAT IS GRANTED
--
--   delivery_items   insert, update    the van's lines and a corrected count
--   wastage          insert, update    the shelf count, and a re-count
--
-- Both are upserts in the app (on conflict do update), so update is required
-- as well as insert -- an insert policy alone makes the second tap fail.
--
-- NO DELETE, for anyone, consistent with 078, 080 and 091: this is a record of
-- what happened. A wrong number is corrected by writing the right one, which
-- leaves the correction visible; a wrong number that can be removed leaves
-- nothing behind at all.
--
-- NOT SCOPED TO THIS DRIVER'S RUN, and that is not an oversight being waved
-- through. There is no driver-to-run assignment anywhere in this system --
-- 014 said so in a TODO in August and it is still true. Every driver policy in
-- the build has the same limit, so this migration does not widen anything; it
-- closes the gap between what the app writes and what a driver is allowed to
-- write. When the assignment exists, every `using` clause named here and in
-- 014, 025 and 080 tightens to it in one migration.
--
-- Idempotent. Safe to run more than once.

begin;

-- ---------------------------------------------------------------------------
-- What was in the van.
-- ---------------------------------------------------------------------------
drop policy if exists driver_delivery_items_insert on delivery_items;
drop policy if exists driver_delivery_items_update on delivery_items;

create policy driver_delivery_items_insert on delivery_items
  for insert with check ((select public.current_app_role()) = 'driver');

create policy driver_delivery_items_update on delivery_items
  for update using      ((select public.current_app_role()) = 'driver')
             with check ((select public.current_app_role()) = 'driver');

-- ---------------------------------------------------------------------------
-- What came off the shelf.
--
-- A confirmed nil is written as an explicit zero rather than left absent,
-- because v_store_week reads
--
--   coalesce(waste.total_wasted, greatest(sent - sold, 0))
--
-- and an absent row means "nobody said, infer it from the gap". The driver's
-- zero only beats that inference if it reaches this table, which is what these
-- two policies are for.
-- ---------------------------------------------------------------------------
drop policy if exists driver_wastage_insert on wastage;
drop policy if exists driver_wastage_update on wastage;
drop policy if exists driver_wastage_read   on wastage;

create policy driver_wastage_insert on wastage
  for insert with check ((select public.current_app_role()) = 'driver');

create policy driver_wastage_update on wastage
  for update using      ((select public.current_app_role()) = 'driver')
             with check ((select public.current_app_role()) = 'driver');

-- Read as well, so the screen can show a driver the count they just entered
-- if they tap back. Without it the upsert's ON CONFLICT still works -- the
-- conflict check is not a policy read -- but the app can never display it.
create policy driver_wastage_read on wastage
  for select using ((select public.current_app_role()) = 'driver');

comment on table wastage is
  'What came off the shelf, per store per product per day, captured by the driver at the stop. Source of truth for waste: v_store_week and v_waste_trend prefer it over the sent-minus-sold inference, so a confirmed nil must be written as an explicit 0 rather than left absent. captured_by references app_users (legacy) and is left null by the driver app; who recorded it is on the deliveries row for the same store and day. Driver insert/update/select added in migration 092, 10 September.';

commit;

-- Verify -- expect six rows, the SELECT on delivery_items being the one that
-- was already there:
--
--   select tablename, policyname, cmd from pg_policies
--    where tablename in ('delivery_items','wastage')
--      and policyname like 'driver%'
--    order by tablename, policyname;
--
--   delivery_items  driver_delivery_items_insert  INSERT
--   delivery_items  driver_delivery_items_update  UPDATE
--   delivery_items  driver_read_delivery_items    SELECT
--   wastage         driver_wastage_insert         INSERT
--   wastage         driver_wastage_read           SELECT
--   wastage         driver_wastage_update         UPDATE
