-- Migration 080: the photo and the signature are kept.
--
-- Today the driver app captures both and stores neither. The screen says so out
-- loud -- "Deliveries are saved; photos and the signature are not yet" -- and
-- run-state-actions.ts says why: they are images, and a base64 data URL in a
-- jsonb column that is read on every page load turns a 2KB row into a 2MB one.
-- That was the right call. This is the other half of it.
--
-- So a driver photographs the stand, gets a signature, taps Confirm, and the
-- proof evaporates. For a business whose current process is a photo posted into
-- a per-driver WhatsApp group, that is a step backwards, and it is the last hole
-- in the driver flow.
--
-- NOTHING NEW IS INVENTED HERE. 001 already designed this: `deliveries` holds a
-- drop, `delivery_photos` holds its evidence with a storage_path and a sha256,
-- and 014 already gave the driver role insert and select on delivery_photos.
-- What was missing is the three small things that make it usable.
--
-- MEASURED before writing, 3 September:
--
--   storage buckets ......................... 1 (feed-uploads, private)
--   deliveries rows ......................... 799
--   distinct (store_id, delivery_date) ...... 799
--   duplicate (store_id, delivery_date) ..... 0     <- the unique index is safe
--   delivery_photos rows .................... 0     <- adding a column costs nothing
--
-- WHAT THIS ADDS
--
-- 1. A unique key on (store_id, delivery_date). The driver app has no concept of
--    a delivery row today; it will now upsert one per store per day. Without the
--    key, a driver who re-opens a stop creates a second row, and the store page's
--    "sent" figure -- which joins delivery_items -- would start double counting
--    the moment items are ever attached. Verified zero duplicates first: this
--    index cannot fail on the existing 799 rows.
--
-- 2. `kind` on delivery_photos. A signature is an image too, and storing it as
--    an ordinary photo makes the two indistinguishable a week later when
--    somebody is looking for proof a drop happened. Defaults to 'photo' so the
--    column means the same thing for any row written later by another path.
--    Unique on (delivery_id, kind), so a retake REPLACES rather than piling up.
--
-- 3. A private `driver-proof` bucket, and the policies to write to it.
--
-- WHY A SECOND BUCKET AND NOT feed-uploads. Different lifetime and different
-- blast radius. A retailer report is a working file that can be deleted the day
-- after it loads; a signature is evidence and has to outlive the run. Sharing a
-- bucket means one lifecycle rule, and the shorter one always wins by accident.
--
-- WHY NO DELETE, ANYWHERE. Same reason 014 made delivery_photos insert-only and
-- 075 gave the driver no delete on daily_run_state: a record of a drop is
-- evidence, and a driver must not be able to remove evidence of one they missed.
--
-- WHAT IS DELIBERATELY NOT HERE: the driver's licence photo. It is captured at
-- the start of a shift and lives in localStorage for the day. It belongs to a
-- DRIVER, not to a delivery, and there are no driver accounts yet -- so there is
-- nothing to attach it to that would still mean anything tomorrow. It waits for
-- the accounts, with everything else that does.
--
-- Additive and idempotent.

begin;

-- ---------------------------------------------------------------------------
-- 1. One delivery row per store per day, so the app can upsert into it.
-- ---------------------------------------------------------------------------
create unique index if not exists deliveries_store_day_uk
  on deliveries (store_id, delivery_date);

comment on index deliveries_store_day_uk is
  'One drop per store per day. The driver app upserts on this; without it a re-opened stop would create a second delivery row and the store page''s sent figure would double count as soon as items were attached.';

-- ---------------------------------------------------------------------------
-- 2. Tell a signature apart from a shelf photo.
-- ---------------------------------------------------------------------------
alter table delivery_photos
  add column if not exists kind text not null default 'photo';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'delivery_photos_kind_ck'
  ) then
    alter table delivery_photos
      add constraint delivery_photos_kind_ck check (kind in ('photo','signature'));
  end if;
end $$;

create unique index if not exists delivery_photos_kind_uk
  on delivery_photos (delivery_id, kind);

comment on column delivery_photos.kind is
  'photo = the stand at the stop. signature = proof of delivery. Unique per delivery, so a retake replaces rather than accumulating.';

-- ---------------------------------------------------------------------------
-- 3. A driver can record the drop the evidence hangs off.
--
--    Insert and update only. No delete: a record of a drop is evidence.
--    delivery_photos already has driver insert and select from 014; the update
--    is added because a retake upserts on (delivery_id, kind).
-- ---------------------------------------------------------------------------
drop policy if exists driver_deliveries_insert on deliveries;
drop policy if exists driver_deliveries_update on deliveries;

create policy driver_deliveries_insert on deliveries
  for insert with check ((select public.current_app_role()) = 'driver');

create policy driver_deliveries_update on deliveries
  for update using      ((select public.current_app_role()) = 'driver')
             with check ((select public.current_app_role()) = 'driver');

drop policy if exists driver_photos_update on delivery_photos;
create policy driver_photos_update on delivery_photos
  for update using      ((select public.current_app_role()) = 'driver')
             with check ((select public.current_app_role()) = 'driver');

-- ---------------------------------------------------------------------------
-- 4. The bucket. Private, images only, 10MB a file.
--
--    A phone photo is 2-5MB and a signature PNG is a few KB. 10MB is well past
--    a real capture and well under anything that would be a surprise on the
--    bill. The app never writes to it with a user's credentials -- it mints a
--    one-time signed upload URL server-side, exactly as the retailer feed does,
--    so the bucket needs no write policy at all.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
select 'driver-proof', 'driver-proof', false, 10485760,
       array['image/jpeg','image/png','image/webp']
where not exists (select 1 from storage.buckets where id = 'driver-proof');

commit;

-- Verify:
--   select id, public, file_size_limit from storage.buckets order by id;
--   -- expect feed-uploads and driver-proof, both public = false.
--
--   select policyname, cmd from pg_policies
--    where tablename in ('deliveries','delivery_photos')
--      and policyname like 'driver%' order by tablename, policyname;
--   -- expect driver_deliveries_insert/_update and
--   --        driver_photos_insert/_read/_update.
--
--   select indexname from pg_indexes
--    where tablename in ('deliveries','delivery_photos')
--      and indexname in ('deliveries_store_day_uk','delivery_photos_kind_uk');
--   -- expect both.
