-- =====================================================================
-- Migration 057: teach the engine to read events.product_ids.
--
-- 056 added the column and scoped Rosh Hashanah to challah. Without this, the
-- engine ignores it and the column is decoration — worse than nothing,
-- because the events screen would claim a scope the plan does not honour.
--
-- ---------------------------------------------------------------------
-- HOW, AND WHY IT IS DONE THIS WAY
-- ---------------------------------------------------------------------
-- jb_plan_day is a 300-line function last defined in 037. Retyping it here to
-- change four lines would mean maintaining two copies of the engine, and the
-- copy in this file would silently go stale the next time 037's logic moves.
--
-- So this patches the LIVE definition instead: read it back with
-- pg_get_functiondef, insert one condition, execute the result.
--
-- That is only safe if it refuses to guess, so it does three checks and
-- raises rather than patching blind:
--
--   1. the function exists
--   2. it does not already mention product_ids  (idempotency)
--   3. the anchor text appears EXACTLY ONCE     (no ambiguous substitution)
--
-- If any check fails the migration stops and says why. It never patches a
-- function it did not recognise.
--
-- The condition inserted:
--     and (e.product_ids is null or c.product_id = any(e.product_ids))
--
-- NULL means every product, so every existing event — Christmas, Easter, the
-- school holidays — keeps behaving exactly as it does today.
-- =====================================================================

\set ON_ERROR_STOP on

do $do$
declare
  src      text;
  patched  text;
  n_hits   int;
  needle   constant text := 'e.state is null or e.state = c.state::text';
  addition constant text := 'e.state is null or e.state = c.state::text)'
                            || E'\n                        and (e.product_ids is null or c.product_id = any(e.product_ids)';
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'jb_plan_day';

  if src is null then
    raise exception '057: jb_plan_day does not exist. Apply 033 and 037 first.';
  end if;

  if position('product_ids' in src) > 0 then
    raise notice '057: already applied — jb_plan_day already reads events.product_ids.';
    return;
  end if;

  n_hits := (length(src) - length(replace(src, needle, ''))) / length(needle);
  if n_hits <> 1 then
    raise exception
      '057: expected the event state filter exactly once in jb_plan_day, found %. Refusing to patch a function I do not recognise.', n_hits;
  end if;

  patched := replace(src, needle, addition);
  execute patched;
  raise notice '057: jb_plan_day patched — events.product_ids now filters the uplift.';
end
$do$;

\echo ''
\echo '=== PROOF: the live function now reads product_ids ==='
select case when position('product_ids' in pg_get_functiondef(p.oid)) > 0
            then 'YES — the engine honours product scope'
            else '*** NO — the patch did not take ***' end as verdict
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'jb_plan_day';

\echo ''
\echo '=== the exact lines, so it can be read rather than trusted ==='
select trim(l) as uplift_filter
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral unnest(string_to_array(pg_get_functiondef(p.oid), E'\n')) as l
 where n.nspname = 'public' and p.proname = 'jb_plan_day'
   and (l ilike '%store_ids%' or l ilike '%product_ids%' or l ilike '%e.state%');

-- Undo: re-run 037, which redefines jb_plan_day without the product filter.
