-- Migration 096: the records could be deleted, and nothing said so.
--
-- WHAT WAS FOUND
--
-- Migration 095 granted jbo_app select, insert and update on driver_licences,
-- and deliberately not delete. Its own verification then reported that jbo_app
-- could delete from it anyway.
--
-- Grants are additive. They never revoke. The cause is one default privilege,
-- visible in pg_default_acl and measured on 11 September:
--
--     postgres | public | tables | { ... jbo_app=arwd/postgres }
--
-- a=insert, r=select, w=update, d=DELETE. Every table ever created in public
-- hands jbo_app the delete bit, automatically, forever.
--
-- MEASURED THE SAME EVENING, against the live database:
--
--     tables in public ................................. 50
--     tables jbo_app can DELETE from ................... 50
--     tables it cannot ................................. 0
--     of those, tables with a permissive ALL/DELETE
--       policy, so a delete would also clear RLS ....... 45
--
-- The policy layer does not save it. biz_all is `for all`, which includes
-- delete, so on 45 tables both halves are open at once.
--
-- WHY IT MATTERS HERE AND NOT EVERYWHERE
--
-- Most of those 50 tables are configuration, and deleting from them is a
-- feature. A store override is removed. A staging table is cleared. A feed load
-- is undone. Revoking delete across the board would break real behaviour and
-- would be a worse migration than this one.
--
-- A handful are not configuration. They are the record of something that
-- happened, and their entire value is that they persist: a delivery, what was
-- in it, the photograph and signature that prove it, the shelf count a driver
-- actually took, who packed the run, and now whose licence was held that day.
-- Those are what a retailer dispute or an accident turns on. "Nobody currently
-- issues a delete" is a much weaker guarantee than "it cannot be deleted", and
-- 095 claimed the second while providing the first.
--
-- WHAT WAS CHECKED BEFORE CHOOSING THE LIST
--
-- Every `delete from` in the repository was read, not assumed. The application
-- -- everything under apps/web that is not a test -- issues exactly five:
--
--     feed_rejects, feed_staging          lib/feeds/ingest.ts
--     store_product_overrides             app/store/actions.ts
--     store_run_overrides                 app/store/actions.ts
--     store_product_days                  app/store/actions.ts
--
-- None of the six tables below appears in that list. The nightly engine and the
-- feed-undo functions do delete from sales_daily, replenishment_plans and
-- events, which is why those three are NOT here -- they run as postgres, a
-- superuser, which bypasses grants and RLS alike, but leaving them out keeps
-- the intent honest rather than relying on that.
--
-- CHECKED IT BREAKS NOTHING
--
--   * db/checks/authorisation-tests.sh deletes from wastage and delivery_items,
--     but via check_refused, which passes on EITHER "permission denied" or zero
--     rows changed. A table-level refusal is the first of those.
--   * apps/web/scripts/test-proof-audit.ts runs `delete from delivery_photos`
--     with no WHERE clause. CI runs it against a throwaway container as user
--     `ci` (postgres://ci:ci@127.0.0.1:5432/ci), not as jbo_app, so this does
--     not touch it. Run by hand against the live database it would today wipe
--     every proof of delivery; after this it cannot. That is a side effect and
--     a welcome one.
--   * The engine and every migration run as postgres and are unaffected.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- It does not change the default privilege. Doing so would quietly deny delete
-- on every table created from here on, and the next migration that assumed
-- otherwise would fail somewhere unrelated. That is a decision to take in
-- daylight, not at the end of a Friday. Until it is taken, A NEW TABLE STILL
-- ARRIVES WITH THE DELETE BIT SET and needs its own revoke if it is a record.
--
-- It does not narrow biz_all. It does not need to: a table grant is checked
-- before any policy, so with delete revoked the policy never gets a say.
--
-- Reversible in one line each:  grant delete on <table> to jbo_app;

revoke delete on deliveries      from jbo_app;
revoke delete on delivery_items  from jbo_app;
revoke delete on delivery_photos from jbo_app;
revoke delete on driver_licences from jbo_app;
revoke delete on wastage         from jbo_app;
revoke delete on packing_records from jbo_app;

comment on table deliveries is
  'A delivery that happened. jbo_app cannot delete from this table (096): the record is the point.';

-- Verify -- expect six rows, every can_delete false and every can_insert true:
--
--   select c.relname,
--          has_table_privilege('jbo_app', c.oid, 'delete') as can_delete,
--          has_table_privilege('jbo_app', c.oid, 'insert') as can_insert
--     from pg_class c join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public'
--      and c.relname in ('deliveries','delivery_items','delivery_photos',
--                        'driver_licences','wastage','packing_records')
--    order by 1;
