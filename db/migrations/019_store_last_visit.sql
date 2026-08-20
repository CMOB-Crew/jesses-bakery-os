-- Migration 019: per-store "last visited" date (Simona's ask, 20 Aug 2026).
-- An editable date on the store profile Simona keeps current herself; drives an
-- "overdue for a visit" flag. Lives on store_settings (already the per-store
-- write-back home), so no new table and it inherits store_settings' RLS.
-- Additive + idempotent.
alter table store_settings
  add column if not exists last_visit_on date;

comment on column store_settings.last_visit_on is
  'Date this store was last physically visited. Set by ops on the store profile; null = never recorded.';

-- Verify:
--   select store_id, last_visit_on from store_settings where last_visit_on is not null;
