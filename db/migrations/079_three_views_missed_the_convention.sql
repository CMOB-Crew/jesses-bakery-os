-- Migration 079: three views never got security_invoker, so they read straight
-- past RLS.
--
-- Found while sweeping the AUTH_ENFORCED flip's blast radius, after 078.
--
-- MEASURED, 3 September:
--
--   views in public ................................ 13
--   with security_invoker = on ..................... 10
--   WITHOUT ........................................  3
--       v_event_scope        (036, replaced by 063)
--       v_engine_staleness   (068, replaced by 070)
--       v_engine_nights      (069, replaced by 070)
--
-- Migration 013 set the convention: "security_invoker = on makes each view
-- execute as the CURRENT user". Every later migration that touched a view
-- re-asserted it -- 021, 031, 032, 034, 040, 041 all carry the line. These
-- three did not.
--
-- WHY THEY LOST IT. `create or replace view` keeps a view's options; `create
-- view` after a drop does not. 070 drops and recreates both engine views, so
-- whatever 068 and 069 had went with them. v_event_scope was created in 036,
-- after 013 had already been applied, so it never had it in the first place.
--
-- WHAT IT MEANS. A view without security_invoker executes as its OWNER, which
-- here is postgres. RLS on the underlying tables is not evaluated at all. So
-- once the app connects as jbo_app -- which holds select on all 60 objects in
-- public, because that is how the grants were written -- ANY signed-in user
-- reads these three in full, whatever their role. The 57 policies underneath
-- them do not get a say.
--
-- HOW BAD, honestly: not very. The three carry engine run metadata (night,
-- last_run_sydney, status, sales_as_of) and event definitions (name, dates,
-- uplift_pct, stores_affected). No customer, no price, no address. This is a
-- convention that slipped rather than an exposure to panic about. It is worth
-- fixing now because it is three lines, and because "10 of 13 follow the rule"
-- is the state a codebase is in just before somebody adds a fourth.
--
-- SAFE TO APPLY. Checked what reads them before writing this:
--   * v_event_scope  -- read by lib/queries.ts for the seasonality and events
--     screens, which are admin surfaces. biz_all admits admin, manager and
--     office on every table underneath, so those reads are unaffected.
--   * v_engine_staleness, v_engine_nights -- not referenced anywhere in the app.
--     They are operator views, read by hand and by the engine checks.
--   * The nightly engine runs as postgres, a superuser, which bypasses RLS
--     regardless of this setting. 033 and 034 already established that the
--     engine works through security_invoker views over force-RLS tables.
--
-- Reversible in one line each if it ever bites: set (security_invoker = off).
--
-- Idempotent: setting an option that is already set is a no-op.

begin;

alter view v_event_scope      set (security_invoker = on);
alter view v_engine_staleness set (security_invoker = on);
alter view v_engine_nights    set (security_invoker = on);

commit;

-- Verify -- expect 13 rows, every one 'security_invoker=on':
--
--   select c.relname,
--          coalesce((select o from unnest(coalesce(c.reloptions,'{}')) o
--                     where o like 'security_invoker%'), 'NOT SET') as invoker
--     from pg_class c
--     join pg_namespace n on n.oid = c.relnamespace
--    where n.nspname = 'public' and c.relkind in ('v','m')
--    order by c.relname;
