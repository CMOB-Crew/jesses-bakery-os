-- ---------------------------------------------------------------------------
-- 105  NOBODY AT THE BAKERY COULD RESET A PASSWORD, OR SWITCH AN ACCOUNT OFF.
--
-- Measured 15 September: there is no people, users, staff or admin screen in
-- this application. Creating an account, resetting a password and switching
-- someone off are all done by running scripts/provision-users.mjs from a
-- terminal with SUPABASE_SERVICE_ROLE_KEY. Two people can do that and both
-- work for CMOB.
--
-- The Runbook says it out loud: "Their password has to be reset and handed to
-- them directly. That is a CMOB job today." So every forgotten password on the
-- bakery floor is a phone call to Javonte, and that does not stop at handover
-- unless something changes.
--
-- WHY EMAIL DOES NOT SOLVE IT
--
-- The obvious fix is a working "forgot password" link. It does not help the
-- people who need it: driver and packer addresses have no mailbox behind them
-- at all, so a reset email is sent into nothing. Custom SMTP is worth doing for
-- Simona and the office (auth-email-setup.md, still not done) and it would not
-- move this one inch.
--
-- WHAT THIS MIGRATION IS
--
-- Only the audit trail. The screen itself is application code.
--
-- Handing account control to the bakery means somebody other than CMOB can
-- mint a password for another human being. That is the right trade -- the
-- alternative is CMOB holding a key forever -- but it must leave a record, and
-- the record has to survive the person who made it.
--
-- WHAT IS DELIBERATELY NOT IN HERE
--
--   * No password, ever, in any column, in any form. Not hashed, not masked,
--     not "first two characters". The generated password is shown once on the
--     screen of the person who pressed the button and is never written down by
--     the system.
--   * No row is ever updated or deleted. It is append-only by policy below,
--     because an audit trail somebody can edit is not one.
--   * The target's email is copied in as text rather than only referenced.
--     Accounts get deleted; the record of who reset them should not vanish
--     with the row it pointed at.
-- ---------------------------------------------------------------------------

create table if not exists public.user_admin_events (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),

  -- Who did it. Both the id and the email, for the reason above.
  actor_id     uuid references public.users(id) on delete set null,
  actor_email  text not null,
  actor_role   text not null,

  -- What they did. Constrained rather than free text, so a report can group on
  -- it in a year without anybody having to guess the spellings that were used.
  action       text not null check (action in
                 ('created', 'password_reset', 'deactivated', 'reactivated', 'role_changed')),

  -- Who it was done to.
  target_id    uuid references public.users(id) on delete set null,
  target_email text not null,
  target_role  text,

  -- Anything the action needs to be intelligible later: the old and new role on
  -- a role change, and nothing at all on a password reset.
  detail       jsonb not null default '{}'::jsonb
);

comment on table public.user_admin_events is
  'Every account action taken from the People screen: created, password reset, switched off, switched back on, role changed. Append-only -- there is no update or delete policy, deliberately. NEVER contains a password in any form. Added by migration 105 on 15 September 2026, when account control moved out of a CMOB terminal and into the app so the bakery could run without us.';

create index if not exists user_admin_events_at_idx
  on public.user_admin_events (at desc);
create index if not exists user_admin_events_target_idx
  on public.user_admin_events (target_id, at desc);

-- ---------------------------------------------------------------------------
-- Row level security.
--
-- FORCE as well as ENABLE. Migration 103 closed public.users for exactly this
-- reason four days ago: policies do not apply to a table's owner unless FORCE
-- is set, and db/checks/rls-coverage.sql now fails any table missing either
-- half. A new table that only ENABLEs would reopen that hole.
-- ---------------------------------------------------------------------------
alter table public.user_admin_events enable row level security;
alter table public.user_admin_events force row level security;

-- Readable by the two roles that can reach the screen. office is deliberately
-- excluded: it can see the whole application but has no business reading who
-- reset whose password.
drop policy if exists user_admin_events_select on public.user_admin_events;
create policy user_admin_events_select on public.user_admin_events
  for select
  using (public.current_app_role() in ('admin', 'manager'));

-- Insert only, and only as yourself. actor_id has to be the person signed in,
-- so a row cannot be written in somebody else's name.
drop policy if exists user_admin_events_insert on public.user_admin_events;
create policy user_admin_events_insert on public.user_admin_events
  for insert
  with check (
    public.current_app_role() in ('admin', 'manager')
    and actor_id = auth.uid()
  );

-- No update policy and no delete policy. Under RLS, absent means denied, so
-- this is append-only for everyone including the roles that can read it.


-- ---------------------------------------------------------------------------
-- AND THE ONE THAT WOULD HAVE MADE THE SCREEN EMPTY.
--
-- public.users has had exactly three policies since migration 012:
--
--     users_read_self    select, id = auth.uid()
--     users_admin_read   select, jb_is_admin()
--     users_admin_write  all,    jb_is_admin()
--
-- So a MANAGER can read their own row and nothing else. Simona would have
-- opened the People screen and seen one person: herself. Not an error, not a
-- refusal -- a list of one, which reads as a broken page.
--
-- This adds the read. It does NOT add a write, and that is deliberate:
--
--   * Reading is a policy question and belongs in the database.
--   * Writing is not, because the write does not go through RLS at all. Creating
--     an account and setting a password are Supabase auth admin calls, which
--     use the service role key and bypass every policy by definition. A write
--     policy here would be decorative -- it would look like the control while
--     the actual control was somewhere else, which is the failure mode
--     db/RLS-AUDIT-2026-09-10.md spent a page on.
--
-- What bounds a manager's writes is lib/people-rules.ts, asserted in
-- scripts/people-check.ts, and every one of them lands in the table above.
-- ---------------------------------------------------------------------------
drop policy if exists users_manager_read on public.users;
create policy users_manager_read on public.users
  for select
  using (public.current_app_role() = 'manager');

comment on policy users_manager_read on public.users is
  'A manager can see the staff list so the People screen works for them. Read only -- account writes do not go through RLS at all, they go through the Supabase auth admin API on the service role key, and are bounded by lib/people-rules.ts instead. Added by migration 105, 15 September 2026.';
