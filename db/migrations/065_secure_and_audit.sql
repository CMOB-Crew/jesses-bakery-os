-- =====================================================================
-- Migration 065: secure the table I left open, and read the real account state.
--
-- ---------------------------------------------------------------------
-- 1. jb_plan_before_064 HAS NO RLS
-- ---------------------------------------------------------------------
-- apply-064.sh created it with `create table ... as select` to hold the plan
-- before the zero-fill fix, so the before/after could be proved. It was never
-- given row-level security, and it is the ONLY unprotected table in the public
-- schema.
--
-- It holds every store, product and recommended quantity in the plan. That is
-- commercially sensitive and it has been sitting readable since this morning.
--
-- Every other backup table in this build does this properly:
-- jb_events_backup_056, jb_fn_backup_064, jb_store_days_backup_052. This one
-- was written in a hurry as part of an apply script rather than a migration,
-- which is exactly how it slipped.
--
-- Fixed rather than dropped: the comparison it supports is the evidence for a
-- change to the forecasting core six days before go-live, and it is small.
-- Drop it after go-live with `drop table jb_plan_before_064;`.
--
-- ---------------------------------------------------------------------
-- 2. THE ACCOUNT PICTURE, READ FROM THE RIGHT TABLE
-- ---------------------------------------------------------------------
-- The readiness check read auth.users.raw_user_meta_data->>'role' and found
-- nothing, which proves only that roles are not kept there.
--
-- Migration 012 puts them in public.users, and is explicit about the default:
--
--   'role NULL = no access (default deny); an admin grants a real role.
--    Read by security-definer helpers, never trusted from the token.'
--
-- So the question that actually matters for go-live is how many rows in
-- public.users carry a real role, and whether anyone is stranded at NULL.
--
-- Idempotent. Reports only, apart from the RLS.
-- =====================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- The fix.
-- ---------------------------------------------------------------------
alter table jb_plan_before_064 enable row level security;
alter table jb_plan_before_064 force  row level security;
drop policy if exists biz_all on jb_plan_before_064;
create policy biz_all on jb_plan_before_064 for all
  using      (public.current_app_role() in ('admin','manager','office'))
  with check (public.current_app_role() in ('admin','manager','office'));

comment on table jb_plan_before_064 is
  'Snapshot of replenishment_plans taken immediately before migration 064, so the zero-fill correction could be proved per day. Evidence only; nothing reads it. Safe to drop after go-live.';

\echo ''
\echo '=== 1. RLS — every public table, ZERO rows expected ==='
select c.relname as still_unprotected
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
 order by 1;

\echo ''
\echo '=== 2. THE REAL ACCOUNT PICTURE — public.users, not auth metadata ==='
\echo '    role NULL means NO ACCESS. Anyone sitting at NULL cannot use the'
\echo '    system even though they can authenticate.'
select coalesce(u.role, 'NULL — no access') as role,
       count(*)                             as accounts,
       count(*) filter (where u.is_active)   as active,
       string_agg(u.email, ', ' order by u.email) as who
  from public.users u
 group by 1 order by 2 desc;

\echo ''
\echo '=== 3. AUTH vs APP — anyone able to sign in but with no role? ==='
select au.email,
       (au.last_sign_in_at is not null)      as has_signed_in,
       coalesce(pu.role, 'NULL — no access') as app_role,
       coalesce(pu.is_active::text, '(no row)') as is_active
  from auth.users au
  left join public.users pu on pu.id = au.id
 order by au.email;

\echo ''
\echo '=== 4. THE ONE DARK WOOLWORTHS STORE — named ==='
\echo '    86 of 87 Woolworths report. The odd one out is worth knowing about'
\echo '    before someone asks why it looks dead.'
with a as (select coalesce(max(sale_date), current_date) as d from sales_daily),
live as (select distinct sd.store_id from sales_daily sd, a
          where sd.sale_date > a.d - 7 and sd.sale_date <= a.d)
select s.name, s.retailer::text as retailer,
       (select max(sd.sale_date) from sales_daily sd where sd.store_id = s.id) as last_sale,
       (select r.name from regions r where r.id = s.region_id) as region
  from stores s
  left join live l on l.store_id = s.id
 where s.active and s.retailer::text = 'woolworths' and l.store_id is null;

\echo ''
\echo '=== 5. THE 20 RUNS WITH NO DAYS — are they the legacy rows? ==='
\echo '    queries.ts says the twenty legacy "Run N" rows from 043 are not runs'
\echo '    anyone drives and are filtered out of the board. Confirming that is'
\echo '    what these are, and not a real run someone forgot to set up.'
select r.name,
       coalesce(cardinality(r.run_days),0) as days,
       (select count(*) from stores s where s.default_run_id = r.id and s.active) as stores_pointing_at_it
  from runs r
 where r.run_days is null or cardinality(r.run_days) = 0
 order by 3 desc, 1;

\echo ''
\echo '=== 6. 94 ACTIVE PRODUCTS NEVER SOLD IN 180 DAYS ==='
\echo '    The engine gates on 180d so it will not plan them, but they still'
\echo '    fill the Products page. Top 15 by how long dead.'
select p.name,
       (select max(sd.sale_date) from sales_daily sd where sd.product_id = p.id) as last_ever_sold
  from products p
 where p.active
   and not exists (select 1 from sales_daily sd where sd.product_id = p.id
                    and sd.sale_date > jb_asof() - 180)
 order by 2 nulls first
 limit 15;

\echo ''
\echo '=== 7. THE 7 STORES WITH NO DELIVERY DAYS — named ==='
select s.name, s.retailer::text as retailer,
       (select rn.name from runs rn where rn.id = s.default_run_id) as run
  from stores s
 where s.active and (s.delivery_days is null or cardinality(s.delivery_days) = 0)
 order by 1;
