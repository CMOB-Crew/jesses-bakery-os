-- ---------------------------------------------------------------------------
-- 106  THE APPLICATION'S ROLE CANNOT CALL auth.uid(), AND NOTHING HAD EVER
--      ASKED IT TO.
--
-- /people shipped this morning and said "Could not read the staff list".
-- Measured against production, as jbo_app, with a real session's claims set:
--
--     select auth.uid()                    ERROR: permission denied for schema auth
--     select ... from public.users         14 rows
--     select count(*) ... where role=admin 2
--     select ... from user_admin_events    (empty, fine)
--
-- So migration 105 was right and the grants were right. Two queries in
-- lib/people.ts called auth.uid() DIRECTLY in the query text, and jbo_app has
-- no USAGE on schema auth.
--
-- WHY IT HAD NEVER BITTEN
--
-- Nothing in this codebase had ever called it. Every read goes through
-- public.current_app_role() or public.jb_is_admin(), both SECURITY DEFINER and
-- owned by postgres, so both reach into auth on their owner's rights. Migration
-- 012 built those wrappers for the role and nobody had needed the id, so the id
-- never got one.
--
-- WHAT THIS ADDS
--
-- The missing wrapper, in the same shape as the two that already exist, with
-- the same pinned search_path -- and then the ONE POLICY that would have hit
-- the same wall: user_admin_events_insert, written yesterday as
-- `actor_id = auth.uid()`, which would have failed for exactly the same reason
-- the moment anybody pressed a button.
--
-- That policy passing its tests and still being unusable is worth naming: the
-- apply script asserted the policy EXISTED and that its expression mentioned
-- auth.uid(). Both were true. Neither told us it could not run.
--
-- SECURITY DEFINER, AND WHY THAT IS NOT A WIDENING
--
-- It returns auth.uid() and nothing else: the id of the session already
-- talking to the database. A caller cannot pass anything in and cannot get
-- back anybody else's id, so the most it can tell you is who you already are.
-- search_path is pinned, per the standing rule and the six definer functions
-- audited on 11 September.
--
-- Reversible:
--
--     drop policy if exists user_admin_events_insert on public.user_admin_events;
--     create policy user_admin_events_insert on public.user_admin_events
--       for insert with check (public.current_app_role() in ('admin','manager')
--                              and actor_id = auth.uid());
--     drop function if exists public.jb_uid();
-- ---------------------------------------------------------------------------

create or replace function public.jb_uid()
  returns uuid
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select auth.uid();
$$;

comment on function public.jb_uid() is
  'The signed-in session''s user id, for callers that cannot reach schema auth -- which is every application role. The counterpart to jb_role() and jb_is_admin() from migration 012, which wrapped the ROLE for the same reason and left the id unwrapped because nothing needed it until the People screen. Returns only the caller''s own id: it takes no argument and cannot be asked about anybody else. Added 15 September 2026, migration 106.';

-- The application roles. authenticated and anon are listed because Supabase's
-- own PostgREST path uses them, and a function only half the roles can call is
-- the same bug in a different shirt.
grant execute on function public.jb_uid() to jbo_app, authenticated, anon, service_role;

-- ---------------------------------------------------------------------------
-- And the policy that carried the same fault.
--
-- Written yesterday as `actor_id = auth.uid()`. The intent is right and does
-- not change: a row cannot be written in somebody else's name. What changes is
-- that it can now actually be evaluated by the role doing the insert.
-- ---------------------------------------------------------------------------
drop policy if exists user_admin_events_insert on public.user_admin_events;
create policy user_admin_events_insert on public.user_admin_events
  for insert
  with check (
    public.current_app_role() in ('admin', 'manager')
    and actor_id = public.jb_uid()
  );

comment on policy user_admin_events_insert on public.user_admin_events is
  'Insert only, and only as yourself. Uses public.jb_uid() rather than auth.uid() directly, because the application role has no USAGE on schema auth -- migration 106, after /people could not read its own staff list.';
