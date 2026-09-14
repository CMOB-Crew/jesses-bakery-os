-- ---------------------------------------------------------------------------
-- 098  CONDITION 12: A DELIVERY NAMES ITS DRIVER AND ITS RUN.
--
-- Condition 12 of the 11 August stack decision record:
--
--     "Delivery records carry driver identity, store and run validation, and
--      duplicate detection per store per day."
--
-- Audited 11 September and recorded as not met: deliveries.run_id and
-- deliveries.driver_id have existed since migration 001 and NOTHING HAS EVER
-- WRITTEN EITHER OF THEM.
--
-- WHY THEY WERE NEVER WRITTEN. IT IS NOT THAT SOMEBODY FORGOT.
--
-- deliveries.driver_id references app_users(id). The application, the
-- provisioning script and every RLS policy use public.users(id), which is
-- keyed on auth.uid(). They are two different identity systems and migration
-- 082 already said so out loud:
--
--     "app_users is a staff directory from the original build. public.users is
--      the auth identity, keyed to auth.uid(), and is the only one any policy
--      reads."
--
-- So driver_id was not fillable from a signed-in driver. Pointing a modern
-- account at it would have been a foreign key into the wrong keyspace, which
-- is exactly why wastage.captured_by is deliberately left null today, with a
-- comment in driver-proof-actions.ts saying why.
--
-- The column was not neglected. It was unusable.
--
-- WHAT THIS DOES
--
-- Repoints deliveries.driver_id at public.users(id), the identity system every
-- other part of this build already uses. Nothing is dropped and no data moves:
-- the column is empty, so there is nothing to migrate and no risk of orphaning
-- a row.
--
-- ON DELETE SET NULL, not CASCADE. Removing a person must never remove the
-- record that a delivery happened. The delivery is the business fact; who
-- carried it is an attribute of it.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
--   * wastage.captured_by is left pointing at app_users. Same fault, same
--     one-line fix, but it needs its own write path and its own test and this
--     migration is about condition 12. Named here so it is on the record
--     rather than rediscovered.
--   * app_users is not dropped. It is a legacy directory, migration 014 has
--     RLS on it, and removing a table on the day of a handover is not a thing
--     to do casually.
--   * Nothing is backfilled. Every delivery recorded before today has no
--     driver and no run, and inventing one would be worse than the gap.
--
-- THE THIRD CLAUSE WAS ALREADY MET. "Duplicate detection per store per day" is
-- migration 080's unique key on (store_id, delivery_date), and both write
-- paths upsert onto it. This migration completes the other two.
--
-- Reversible:
--     alter table deliveries drop constraint deliveries_driver_id_fkey;
--     alter table deliveries add constraint deliveries_driver_id_fkey
--       foreign key (driver_id) references app_users(id);
-- ---------------------------------------------------------------------------

alter table deliveries
  drop constraint if exists deliveries_driver_id_fkey;

alter table deliveries
  add constraint deliveries_driver_id_fkey
  foreign key (driver_id) references public.users(id) on delete set null;

-- Reading back "which stops did this driver do today" is the query condition 15's
-- first test needs and cannot currently express. It is not met by this migration
-- -- run assignment still does not exist -- but the index is what that query will
-- want and it costs nothing on an empty column.
create index if not exists deliveries_driver_day_idx
  on deliveries (driver_id, delivery_date);

create index if not exists deliveries_run_day_idx
  on deliveries (run_id, delivery_date);

comment on column deliveries.driver_id is
  'The person who made the drop, as public.users(id) -- the auth identity, not the legacy app_users directory it referenced until migration 098. Written by driver-proof-actions.ts from the signed-in session. NULL for every delivery recorded before 14 September 2026, and NULL if the signed-in account has no public.users row, because a wrong driver is worse than no driver.';

comment on column deliveries.run_id is
  'The run this stop belonged to, VALIDATED against the store''s own run for that weekday before it is written -- store_run_overrides for the day if one exists, otherwise stores.default_run_id. A run the store is not on is not written at all: the delivery still records, with run_id NULL. Condition 12, migration 098.';
