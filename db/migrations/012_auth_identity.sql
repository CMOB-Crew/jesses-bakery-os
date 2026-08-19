-- Migration 012: auth identity + roles (Phase A of the Auth/RLS foundation)
-- Source: Stack Decision Record v1.1.0 (Fred, amended 18 Aug 2026) -- Supabase
--   Auth; roles live in the database (public.users keyed on auth.uid()), read by
--   a stable security-definer helper; new accounts default to NO role and NO
--   access until an admin grants one.
--
-- This migration is the identity layer only. It does NOT enable RLS on the
-- business tables yet -- that is migration 014 (deny-by-default + policies),
-- which is applied LAST, after the per-request data-access wrapper (lib/db.ts
-- runAsUser) is live and the two-user test passes.
--
-- Connection model: Option A, CONFIRMED by Fred 19 Aug 2026 -- keep the raw
-- postgres.js / SQL layer and inject the verified user's JWT claims per request
-- (transaction-local set_config). No query rewrite. See the Auth-RLS build plan.
--
-- Apply ORDER: 012 (this, identity) -> 013 (views security_invoker) -> wire +
-- test the wrapper -> 014 (enable RLS on business tables). 012 alone is safe:
-- it adds one new table + helpers + a signup trigger, and touches no existing
-- table or query, so it can go in now.
--
-- Idempotent: guarded creates. Safe to run more than once.

-- Roles. NULL = no access (default deny). An admin assigns a real role.
--   admin   -- full access, can grant roles
--   manager -- ops manager (Simona): full business read/write
--   office  -- office staff: business read/write, no user admin
--   driver  -- delivery PWA: only their own runs
create table if not exists public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        text check (role is null or role in ('admin','manager','office','driver')),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.users is
  'Application identity + role, keyed on auth.uid(). role NULL = no access (default deny); an admin grants a real role. Read by security-definer helpers, never trusted from the token.';

-- Security-definer helpers. SECURITY DEFINER so they bypass RLS on public.users
-- and cannot recurse when called from a policy. search_path pinned for safety.
create or replace function public.current_app_role()
  returns text
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select role from public.users where id = auth.uid() and is_active;
$$;

create or replace function public.jb_is_admin()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users
    where id = auth.uid() and is_active and role = 'admin'
  );
$$;

-- New signups land as a locked-down row: role NULL, no access. An admin promotes
-- them later. Runs as definer so the insert succeeds under RLS.
create or replace function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- RLS on the identity table itself: a user sees only their own row; admins see
-- and manage all. Admin check is the definer helper, so no policy recursion.
alter table public.users enable row level security;

drop policy if exists users_read_self on public.users;
create policy users_read_self on public.users
  for select using (id = auth.uid());

drop policy if exists users_admin_read on public.users;
create policy users_admin_read on public.users
  for select using (public.jb_is_admin());

drop policy if exists users_admin_write on public.users;
create policy users_admin_write on public.users
  for all using (public.jb_is_admin()) with check (public.jb_is_admin());

-- BOOTSTRAP (one-time, manual): default-deny means the first account has no role
-- and nobody can grant one. After the first real person signs in, promote them
-- to admin by hand, once:
--   update public.users set role = 'admin' where email = '<first-admin-email>';

-- Verify after apply:
--   select id, email, role, is_active from public.users order by created_at;
