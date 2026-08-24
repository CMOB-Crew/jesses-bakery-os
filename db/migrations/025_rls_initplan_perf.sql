-- Migration 025: make the RLS policies evaluate once per query, not once per row
--
-- Found 24 Aug 2026, immediately after the 1.15M-row legacy sales load. The app
-- went blank while every query was still fast in psql. The difference: psql
-- connects as postgres (BYPASSRLS); the app connects as jbo_app, where the
-- policies actually run.
--
--   select count(*) from sales_daily   as postgres :   185 ms
--   select count(*) from sales_daily   as jbo_app  : 9,456 ms
--
-- Netlify's function timeout is 10s, so the Overview page died waiting.
--
-- Cause: 014 wrote the predicate as
--     using (public.current_app_role() in ('admin','manager','office'))
-- current_app_role() is STABLE, but a bare function call in a USING clause is
-- still re-evaluated per row -- 1.15 million calls, each one a lookup into
-- public.users. At 2,273 rows nobody noticed. At 1.15M it is the whole budget.
--
-- Fix: wrap the call in a scalar subquery -- (select public.current_app_role()).
-- Postgres then hoists it into an InitPlan and evaluates it ONCE per query.
-- This is the documented Supabase RLS performance pattern.
--
-- SECURITY IS UNCHANGED. Same predicate, same roles, same allow/deny outcome for
-- every row. The only difference is how many times the role lookup runs. The
-- two-user test from 22 Aug should give byte-identical results.
--
-- Idempotent: drops and recreates each policy. Safe to run more than once.

do $$
declare
  t text;
  biz text[] := array[
    'regions','runs','products','pricing_tiers','product_prices',
    'stores','store_run_overrides','standing_orders','sales_daily',
    'sales_intraday','feed_status_log','deliveries','delivery_items',
    'delivery_photos','wastage','on_hand_ledger','replenishment_plans',
    'events','packing_records','ingredient_receipts','task_checklists',
    'store_product_overrides'
  ];
begin
  foreach t in array biz loop
    if to_regclass('public.' || t) is null then
      continue;   -- table not created yet on this database; skip, same as 014
    end if;

    execute format('drop policy if exists biz_all on %I', t);
    execute format($p$
      create policy biz_all on %I
        for all
        using      ((select public.current_app_role()) in ('admin','manager','office'))
        with check ((select public.current_app_role()) in ('admin','manager','office'))
    $p$, t);
  end loop;
end $$;

-- Driver surface — same treatment.
drop policy if exists driver_read_deliveries on deliveries;
create policy driver_read_deliveries on deliveries
  for select using ((select public.current_app_role()) = 'driver');

drop policy if exists driver_read_delivery_items on delivery_items;
create policy driver_read_delivery_items on delivery_items
  for select using ((select public.current_app_role()) = 'driver');

drop policy if exists driver_read_stores on stores;
create policy driver_read_stores on stores
  for select using ((select public.current_app_role()) = 'driver');
