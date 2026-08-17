-- Migration 009: launch tracking (new-store rollouts)
-- Source: Simona, 16 Aug 2026 (WhatsApp):
--   "When I roll out a new store I always forget to track it. When I launch
--    something new, track it separately. For example a Queensland launch:
--    stores launched, units per store per day."
--
-- The store master already has onboarded_at (the ACTUAL go-live date, set when a
-- store starts being supplied). What was missing was a way to see a store in the
-- window BEFORE it goes live -- the ones sitting added-but-inactive, waiting on
-- supply. Right now those 5 new Canberra Metro stores fall into the Archive and
-- get labelled "long dormant", which is the exact opposite of what they are.
--
-- This adds one nullable column:
--   * go_live_at = the PLANNED go-live date, set when a store is added as an
--     upcoming rollout. It puts the store in the "Coming up" list on the new
--     Launches page and keeps it OUT of the Archive's dormant list.
-- Lifecycle: added with go_live_at set  ->  goes live: set active = true and
--   onboarded_at = the real date  ->  tracked as a live launch for 6 weeks
--   ->  graduates to a normal store.
--
-- Idempotent: the column add is guarded, and the seed only sets a date where one
-- is not already present. Safe to run more than once.

alter table stores add column if not exists go_live_at date;

comment on column stores.go_live_at is
  'Planned go-live date for an upcoming store rollout. Set when a new store is added but not yet supplied; keeps it in the Launches "Coming up" list and out of the Archive. onboarded_at holds the actual go-live date once supply starts.';

-- Seed the 5 new Woolworths Metro Canberra stores (added inactive in migration
-- 007) with a planned go-live. Simona, 14 Aug: "start in 2-3 weeks" -> planned
-- for early September 2026. This is an editable estimate, not a commitment.
update stores
   set go_live_at = date '2026-09-01'
 where retailer = 'woolworths'::retailer_type
   and supplier_code in ('1457', '1610', '1661', '1089', '8524')
   and active = false
   and onboarded_at is null
   and go_live_at is null;

-- Verify after apply:
--   select name, supplier_code, go_live_at, onboarded_at, active
--   from stores
--   where supplier_code in ('1457','1610','1661','1089','8524')
--   order by supplier_code;
