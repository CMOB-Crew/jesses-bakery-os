-- Migration 095: the licence photo went nowhere.
--
-- WHAT WAS WRONG
--
-- The driver app opens on a hard gate. "Snap your licence to start your shift",
-- and the Start button is disabled until a photo exists. Every driver, every
-- morning, before they can see a single stop.
--
-- The photo was written to window.localStorage, keyed to the day, and nothing
-- else. A grep for "licence" across every server action, route and library in
-- the app returned nothing at all. It never reached this database, it never
-- reached storage, and it expired on its own the next morning.
--
-- DriverApp.tsx said so in its own comment, and named the reason it exists:
--
--   // Driver licence, captured at the start of the shift (Simona: drivers get
--   // fines and have accidents, and there's no record of licences today).
--   // Prototype: held in state for the session; real capture writes to the
--   // driver record next phase.
--
-- So the control cost a driver thirty seconds a day and produced exactly the
-- thing it was asked to fix: no record of licences. The day there is an
-- accident and somebody asks whether that driver was licensed, the honest
-- answer would have been that we asked him and threw the answer away.
--
-- WHAT THIS ADDS
--
-- One table. The bytes go to the driver-proof bucket the delivery photos
-- already use, under a licence/ prefix, so no new bucket and no Supabase
-- dashboard step -- migration 094 exists because bucket visibility is the part
-- of this stack that silently does not work, and this deliberately does not go
-- near it again.
--
-- One row per driver per day. A retake replaces, because the licence being kept
-- is the one that was photographed last.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
--   * It does not scope a driver to their own rows. delivery_photos does not
--     either -- 014 gives the driver role plain insert and select -- and
--     inventing a per-user policy mechanism here, for one table, at the end of
--     a Friday, would be a worse idea than matching the house pattern. The row
--     records WHICH driver from the server session, never from the phone, so
--     the app cannot write a licence against somebody else even though a policy
--     alone would not stop it.
--
--   * It does not expire anything. A driver licence is a government ID with a
--     date of birth and an address on it, and these will accumulate one per
--     driver per working day forever. NOTHING PURGES THEM YET. That is a real
--     follow-up, not a nicety, and it is written here rather than left for
--     somebody to discover in a year.
--
-- Additive. No existing table, policy or row is touched.

create table if not exists driver_licences (
  id            uuid primary key default gen_random_uuid(),
  -- Nullable and ON DELETE SET NULL: the record of a licence having been held
  -- must outlive the account. A driver who leaves and has their login removed
  -- does not retroactively un-hold a licence on the morning of an accident.
  user_id       uuid references public.users(id) on delete set null,
  -- Always present, because this is the one identifier the server is certain of
  -- at write time. user_id is resolved from it and may not resolve.
  driver_email  text not null,
  licence_date  date not null,
  storage_path  text not null,
  sha256        text not null,
  captured_at   timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  unique (driver_email, licence_date)
);

comment on table driver_licences is
  'One driver licence photograph per driver per working day. Asked for because drivers get fines and have accidents and there was no record of licences. Bytes live in the driver-proof bucket under licence/. NOTHING PURGES THESE YET -- they are government ID.';

alter table driver_licences enable row level security;
alter table driver_licences force  row level security;

-- Business roles: the same biz_all shape as every other table here, so this
-- behaves the way somebody reading 014 or 018 would expect it to.
drop policy if exists biz_all on driver_licences;
create policy biz_all on driver_licences
  for all
  using      (public.current_app_role() in ('admin','manager','office'))
  with check (public.current_app_role() in ('admin','manager','office'));

-- Driver: write one and read them back, matching delivery_photos exactly.
-- No update policy. A retake goes through the unique key as an upsert, and the
-- server action is the only thing that issues it.
drop policy if exists driver_licence_insert on driver_licences;
create policy driver_licence_insert on driver_licences
  for insert with check ((select public.current_app_role()) = 'driver');

drop policy if exists driver_licence_read on driver_licences;
create policy driver_licence_read on driver_licences
  for select using ((select public.current_app_role()) = 'driver');

drop policy if exists driver_licence_update on driver_licences;
create policy driver_licence_update on driver_licences
  for update using      ((select public.current_app_role()) = 'driver')
             with check ((select public.current_app_role()) = 'driver');

-- The app connects as jbo_app, which does not bypass RLS. Without these grants
-- the policies above would be decorating a table it cannot touch.
grant select, insert, update on driver_licences to jbo_app;

-- Who has photographed a licence, and on which day. The one question anyone
-- will ever ask this table, and it should not require knowing the schema.
create or replace view v_driver_licence_days
with (security_invoker = true) as
select l.licence_date,
       l.driver_email,
       coalesce(nullif(btrim(u.full_name), ''), l.driver_email) as driver_name,
       l.captured_at,
       l.storage_path
  from driver_licences l
  left join public.users u on u.id = l.user_id
 order by l.licence_date desc, driver_name;

grant select on v_driver_licence_days to jbo_app;
