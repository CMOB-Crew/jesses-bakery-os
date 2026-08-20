-- Migration 014: enable RLS on the business tables (deny-by-default) -- DRAFT / HOLD
-- Source: Auth-RLS build plan; connection model Option A (Fred, 19 Aug 2026).
--
-- ============================ DO NOT APPLY YET ============================
-- This is the LAST step of the foundation and is destructive to access if the
-- request path isn't carrying a verified user yet. Apply ONLY after:
--   1. 012 (identity) and 013 (views security_invoker) are in.
--   2. The per-request wrapper (apps/web/lib/db.ts -> runAsUser) is deployed and
--      AUTH_ENFORCED=1, so every request runs inside a transaction that injects
--      request.jwt.claims. Any query NOT going through the wrapper will see zero
--      rows once this is on.
--   3. The two-user test passes: two users + same query -> different rows; an
--      unauthenticated call -> nothing.
-- Fred is reviewing this file on the PR before it goes near prod.
-- =========================================================================
--
-- Model:
--   role NULL      -> no access (deny-by-default; policies below never match).
--   admin/manager/office -> full business read + write (Simona is 'manager').
--   driver         -> read the delivery surface only (run-scoping is a follow-up,
--                     flagged below -- baseline here is read deliveries + ADD
--                     delivery photos; no update/delete on photos, so proof of
--                     delivery can't be removed).
--   engine         -> writes store_reco/replenishment_plans under its OWN db role
--                     with BYPASSRLS (see the Supabase setup checklist), so it is
--                     deliberately NOT granted through these policies.
--
-- current_app_role() (from 012) reads the role from public.users by auth.uid();
-- roles are never trusted from the token.

-- ---------------------------------------------------------------------------
-- Business tables: one deny-by-default pass. FORCE so the table owner is subject
-- to policy too (a plain app role that doesn't own the table is already subject;
-- FORCE closes the owner gap). Superuser/BYPASSRLS roles (migrations, engine)
-- still bypass, which is what we want for data loads and the engine writer.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  -- Only tables that exist by this migration (001-011). The write-back tables
  -- (store_product_ranging/store_settings/app_settings/daily_run_state) are
  -- created by 015-017, so they're covered in 018 -- keeping them out of here
  -- means the migration set applies cleanly in numeric order (a fresh/CI apply
  -- of 014 before 015-017 would otherwise fail on a not-yet-created table).
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
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);

    -- Business roles: full access. One FOR ALL policy (permissive) covers
    -- select/insert/update/delete for admin, manager, office.
    execute format('drop policy if exists biz_all on %I', t);
    execute format($p$
      create policy biz_all on %I
        for all
        using      (public.current_app_role() in ('admin','manager','office'))
        with check (public.current_app_role() in ('admin','manager','office'))
    $p$, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Driver surface (additive, permissive). Drivers can read the delivery run and
-- confirm drops / attach a photo. NOTE: not yet scoped to *their* runs -- the
-- driver->run link isn't modelled cleanly (app_users has no run assignment yet).
-- Baseline is read-all-deliveries; TODO with Fred: add a driver_runs mapping and
-- tighten these `using` clauses to that driver's runs only.
-- ---------------------------------------------------------------------------
drop policy if exists driver_read_deliveries on deliveries;
create policy driver_read_deliveries on deliveries
  for select using (public.current_app_role() = 'driver');

drop policy if exists driver_read_delivery_items on delivery_items;
create policy driver_read_delivery_items on delivery_items
  for select using (public.current_app_role() = 'driver');

drop policy if exists driver_read_stores on stores;
create policy driver_read_stores on stores
  for select using (public.current_app_role() = 'driver');

-- Insert + read only, deliberately NOT "for all". A proof-of-delivery photo is
-- evidence: a driver may add one and see delivery photos, but must not be able to
-- UPDATE or DELETE a photo (their own or anyone else's) -- that would let a driver
-- remove evidence of a drop they missed. Admin/manager/office keep full access via
-- biz_all above, so nothing legitimate breaks. (Fred, 014 review, 20 Aug 2026.)
drop policy if exists driver_photos on delivery_photos;
drop policy if exists driver_photos_insert on delivery_photos;
drop policy if exists driver_photos_read on delivery_photos;

create policy driver_photos_insert on delivery_photos
  for insert with check (public.current_app_role() = 'driver');

create policy driver_photos_read on delivery_photos
  for select using (public.current_app_role() = 'driver');

-- ---------------------------------------------------------------------------
-- Legacy identity table (app_users): holds pin_hash -> admin-only, no business
-- read. (public.users, the auth-keyed identity, already has its own policies in
-- 012.) app_users is the pre-auth design; it stays locked until it's either
-- mapped into public.users or retired.
-- ---------------------------------------------------------------------------
alter table app_users enable row level security;
alter table app_users force  row level security;
drop policy if exists app_users_admin on app_users;
create policy app_users_admin on app_users
  for all
  using      (public.jb_is_admin())
  with check (public.jb_is_admin());

-- Verify after apply:
--   -- every business table should show rowsecurity = true, forcerowsecurity = true
--   select relname, relrowsecurity, relforcerowsecurity
--   from pg_class where relkind='r' and relnamespace='public'::regnamespace
--   order by relname;
--   -- and the two-user test (run as two different signed-in users):
--   --   set request.jwt.claims -> user A -> select count(*) from stores;  -- their rows
--   --   set request.jwt.claims -> user B -> select count(*) from stores;  -- different
--   --   no claims                         -> select count(*) from stores;  -- 0
