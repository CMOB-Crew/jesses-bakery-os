-- RLS coverage guard (Fred, 014 review, 20 Aug 2026).
--
-- Returns every BASE TABLE in schema `public` that has row-level security
-- DISABLED. Expected result: NO ROWS. If it returns anything, a table is missing
-- RLS -- the structural backstop so a table added later can't silently ship
-- without RLS the way store_product_overrides (and engine_projection) did.
--
-- Views (relkind 'v') and the engine's BYPASSRLS writes are irrelevant here --
-- this only asks "is RLS switched on for each real table". A table that is
-- genuinely, deliberately exempt goes in the allowlist below WITH a reason, so an
-- exemption is a reviewed decision rather than an oversight. Keep it empty if you
-- can: the point is that adding a table forces a conscious RLS choice.

with allowlist(relname, reason) as (
  values
    -- ('example_reference_table', 'read-only lookup, no tenant data'),
    ('__none__', 'placeholder: keeps the CTE valid; matches no real table')
)
select c.relname
from pg_class c
where c.relkind = 'r'
  and c.relnamespace = 'public'::regnamespace
  and not c.relrowsecurity
  and c.relname not in (select relname from allowlist)
order by c.relname;
