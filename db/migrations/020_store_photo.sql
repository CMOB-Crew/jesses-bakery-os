-- Migration 020: per-store profile photo (Simona's ask, 18 Aug — "how I can
-- upload an image to the store's profile"). Stored as a small resized JPEG data
-- URL in a text column, so there's no storage bucket / no service key / no new
-- infra to stand up — the image is resized on the client before it's saved.
-- Lives on store_settings (the per-store write-back home), inherits its RLS.
-- Additive + idempotent.
alter table store_settings
  add column if not exists photo_url text;

comment on column store_settings.photo_url is
  'Store profile photo as a resized JPEG data URL. Set by ops on the store profile; null = none. Client resizes to <=640px before saving to keep the row small.';

-- Verify:
--   select store_id, left(photo_url, 32) from store_settings where photo_url is not null;
