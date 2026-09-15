-- ---------------------------------------------------------------------------
-- 109  SWITCHED OFF STOPPED EVERY READ AND ONE WRITE GOT THROUGH.
--
-- Measured on production on 15 September, standing in as a rehearsal account
-- that had been switched off on the People screen an hour earlier:
--
--     role                  NONE
--     deliveries visible    0          (an active driver sees 801)
--     stores visible        0          (an active driver sees 349)
--     products visible      0          (an active driver sees 116)
--     give themselves a role      refused
--     switch themselves back on   refused
--     CHANGE THEIR OWN NAME       wrote: Switched Off Check
--
-- Everything that goes through a policy was refused, because jb_role() returns
-- a role only for an active row and every policy in this database asks
-- jb_role(). The name did not go through a policy. jb_set_my_name is SECURITY
-- DEFINER -- that is the whole point of it, migration 108 explains why -- and
-- SECURITY DEFINER means row-level security does not apply. Its only gate was
-- "are you signed in", which a switched-off person still is: Supabase Auth and
-- public.users are separate, so the password still works and a token is still
-- issued.
--
-- WHAT IT ACTUALLY COST, because it is smaller than it sounds
--
-- Proof of delivery COPIES the name into the deliveries row at the moment of
-- signing, so nothing already signed can be rewritten from here. And a
-- switched-off person cannot reach the driver screen to sign anything new --
-- they see zero stores and zero deliveries. What is left is that somebody who
-- has left the business can still write arbitrary text into a column Simona
-- reads on the People screen.
--
-- WHY FIX IT ANYWAY
--
-- Because the handover says switching somebody off is real rather than
-- cosmetic, and that sentence has to be true without an asterisk. A person
-- switched off should do NOTHING, and "nothing except one column" is the kind
-- of exception nobody remembers in six months.
--
-- It is also the general lesson for this database, and it is worth stating
-- plainly for whoever adds the next one of these:
--
--     EVERY SECURITY DEFINER FUNCTION STEPS AROUND RLS BY DESIGN, SO EVERY
--     ONE OF THEM MUST RE-CHECK is_active ITSELF. It cannot inherit the
--     answer, because inheriting it is exactly what it turned off.
--
-- jb_set_my_name is the only such function a non-admin can call today. If a
-- second one is ever added, this check belongs in it on the first day.
--
-- Reversible: re-run 108, which replaces this definition with the old one.
-- ---------------------------------------------------------------------------

create or replace function public.jb_set_my_name(new_name text)
  returns text
  language plpgsql
  security definer
  set search_path = public, pg_temp
as $$
declare
  cleaned text;
  me      uuid := auth.uid();
  live    boolean;
begin
  if me is null then
    raise exception 'Not signed in.';
  end if;

  -- THE NEW CHECK. Not inherited from a policy: this function is SECURITY
  -- DEFINER, so no policy is consulted on the update below and none would be.
  --
  -- Read explicitly rather than with a join on the update, so that being
  -- switched off produces a sentence a person can act on instead of an update
  -- that silently changes nothing and reports success.
  select is_active into live from public.users where id = me;
  if live is null then
    raise exception 'There is no account for you to change.';
  end if;
  if not live then
    raise exception 'Your account is switched off, so it cannot be changed. Ask whoever manages accounts to switch it back on.';
  end if;

  cleaned := btrim(coalesce(new_name, ''));

  -- The database's own floor, not a substitute for the application's rules --
  -- lib/people-rules.ts has the readable ones and is asserted. This is here so
  -- the column cannot be filled with rubbish by any caller at all.
  if cleaned = '' then
    raise exception 'A name cannot be empty.';
  end if;
  if length(cleaned) > 80 then
    raise exception 'That name is longer than 80 characters.';
  end if;
  -- No control characters. A newline in a name breaks every place it is
  -- printed, and the delivery receipt is one of them.
  --
  -- [[:cntrl:]] and NOT a range written with backslash-u escapes. The first
  -- version of 108 was written with the escapes and they were interpreted on
  -- the way in, so the file that refuses control characters contained three of
  -- them -- and Postgres lost the IF and asked for a missing THEN. A POSIX
  -- class has nothing to interpret.
  if cleaned ~ '[[:cntrl:]]' then
    raise exception 'A name cannot contain line breaks or control characters.';
  end if;

  -- THE WHOLE POINT: one column, one row, and the row is the caller's own.
  -- There is no argument for whose row it is, so there is nothing to get wrong.
  update public.users
     set full_name = cleaned,
         updated_at = now()
   where id = me;

  return cleaned;
end;
$$;

comment on function public.jb_set_my_name(text) is
  'Lets a signed-in, ACTIVE person set their own display name, and nothing else. A SECURITY DEFINER function rather than an update policy because row-level security grants a WHOLE ROW: a users_update_self policy would also let anybody set their own role, and no arrangement of policies prevents that. Takes no user id, so it cannot be pointed at anybody else. Re-checks is_active ITSELF, because SECURITY DEFINER means no policy is consulted -- migration 109, after a switched-off account was measured still writing this column on 15 September 2026. Added by migration 108.';

grant execute on function public.jb_set_my_name(text) to jbo_app, authenticated;
