-- RLS coverage guard (Fred, 014 review, 20 Aug 2026).
-- Returns every BASE TABLE in schema `public` whose row-level security is not
-- fully on. Expected result: NO ROWS.
--
-- IT USED TO CHECK ONLY relrowsecurity, AND THAT IS WHY A GAP SAT HERE FOR
-- THREE WEEKS WITH CI GREEN.
--
-- Enabling RLS is half the job. Policies do NOT apply to a table's owner
-- unless FORCE ROW LEVEL SECURITY is also set, so a table with RLS enabled
-- and FORCE off is wide open to anything connecting as its owner while
-- reporting as covered. public.users -- the table whose rows decide everyone
-- else's access -- was in exactly that state until migration 103, and this
-- check passed it every run. Ian's RLS audit, finding 4, 10 September 2026.
--
-- Each row now says which half is missing, because "users" on its own would
-- send the next person looking for a policy that is already there.
with allowlist(relname, reason) as (
  values
    ('__none__', 'placeholder: keeps the CTE valid; matches no real table')
)
select c.relname || ' (' ||
       case
         when not c.relrowsecurity and not c.relforcerowsecurity
           then 'row-level security is DISABLED'
         when not c.relrowsecurity
           then 'row-level security is DISABLED'
         else 'RLS is on but NOT FORCED, so policies do not apply to the owner'
       end || ')'
from pg_class c
where c.relkind = 'r'
  and c.relnamespace = 'public'::regnamespace
  and (not c.relrowsecurity or not c.relforcerowsecurity)
  and c.relname not in (select relname from allowlist)
order by c.relname;
