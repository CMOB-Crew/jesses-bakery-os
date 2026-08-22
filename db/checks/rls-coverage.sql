-- RLS coverage guard (Fred, 014 review, 20 Aug 2026).
-- Returns every BASE TABLE in schema `public` that has row-level security
-- DISABLED. Expected result: NO ROWS.
with allowlist(relname, reason) as (
  values
    ('__none__', 'placeholder: keeps the CTE valid; matches no real table')
)
select c.relname
from pg_class c
where c.relkind = 'r'
  and c.relnamespace = 'public'::regnamespace
  and not c.relrowsecurity
  and c.relname not in (select relname from allowlist)
order by c.relname;
