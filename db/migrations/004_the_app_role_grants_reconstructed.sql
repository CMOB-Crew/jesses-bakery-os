-- 004_the_app_role_grants_reconstructed.sql
--
-- NOT THE ORIGINAL 004. Like 003, the original was written, applied to
-- production and never committed. This reconstructs what production actually
-- grants, read off information_schema.role_table_grants on 10 September.
--
-- WHY THIS MATTERS MORE THAN IT LOOKS
--
-- Row-level security decides which ROWS a role may see. Grants decide whether
-- it may touch the table at all, and they are a separate system. 018 turns RLS
-- on for every table; nothing in this repository ever granted jbo_app anything
-- except two engine tables in 033.
--
-- So before this file, a database rebuilt from these migrations would accept
-- the application's connection and then refuse its first query -- permission
-- denied, not zero rows. Every screen in the app, at once. The reason nobody
-- noticed is that production was granted by hand and has been fine ever since.
--
-- WHAT PRODUCTION ACTUALLY HAS
--
-- jbo_app holds SELECT, INSERT, UPDATE and DELETE on all 63 tables and views in
-- public -- no exceptions, including the jb_*_backup_* tables. That is a
-- blanket grant, not a curated list, so it is reproduced as one.
--
-- The DEFAULT PRIVILEGES line is the half that is easy to leave out and the
-- half that keeps this true. v_store_product_delivered was created on
-- 10 September through the SQL editor and already carried jbo_app's grants,
-- which only happens when default privileges are set. Without that line, every
-- future migration would have to remember to grant, and the first one that
-- forgot would take a screen down.
--
-- NOTE ON THE SHAPE OF THE PERMISSION MODEL. A blanket grant looks alarming and
-- is correct here: authorisation is RLS's job, and Fred's decision record is
-- explicit that RLS is the primary control rather than a backstop. The grant is
-- the door; the policy is who gets through it. Narrowing the grant per role
-- would mean two systems disagreeing about the same question.
--
-- Idempotent. Safe to run more than once. A no-op against production.

grant usage on schema public to jbo_app;

grant select, insert, update, delete
   on all tables in schema public
   to jbo_app;

grant usage, select on all sequences in schema public to jbo_app;

-- Tables created AFTER this migration. Without it, 005 onward would each need
-- their own grant and the first one that forgot would be found by a user.
alter default privileges in schema public
  grant select, insert, update, delete on tables to jbo_app;

alter default privileges in schema public
  grant usage, select on sequences to jbo_app;

-- ---------------------------------------------------------------------------
-- Verify, on a fresh database, once every migration has run:
--
--   select count(distinct table_name)
--     from information_schema.role_table_grants
--    where grantee = 'jbo_app' and table_schema = 'public';
--
-- It should equal the number of tables and views in public. On 10 September
-- production returned 63.
-- ---------------------------------------------------------------------------
