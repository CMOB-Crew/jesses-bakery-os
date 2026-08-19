-- Migration 013: views run as the invoker, not the view owner (Auth/RLS foundation)
-- Source: Fred's review, 19 Aug 2026 (the "easy to miss" item).
--
-- A Postgres view runs with the privileges of its OWNER by default. That means
-- RLS policies on the base tables NEVER fire when data is read through a view --
-- the owner sees every row, so the policy underneath is silently bypassed. Our
-- reporting layer reads almost entirely through views (v_store_week, etc.), so
-- without this, migration 014 would "pass" and enforce nothing.
--
-- security_invoker = on makes each view execute as the CURRENT user, so the
-- base-table policies apply as intended. Postgres 15+ (Supabase is 15+).
--
-- Apply AFTER 012 and BEFORE 014. Safe on its own: it changes nothing about the
-- results while RLS is still off; it only matters once 014 enables RLS.
--
-- Idempotent: ALTER VIEW ... SET is safe to re-run.

alter view v_asof              set (security_invoker = on);
alter view v_store_week        set (security_invoker = on);
alter view v_region_week       set (security_invoker = on);
alter view v_network_week      set (security_invoker = on);
alter view v_waste_trend       set (security_invoker = on);
alter view v_store_daily       set (security_invoker = on);
alter view v_unit_revenue      set (security_invoker = on);
alter view v_store_revenue_week set (security_invoker = on);

-- Verify after apply (all should read 'on'):
--   select relname, reloptions from pg_class
--   where relkind = 'v' and relname like 'v\_%' order by relname;
