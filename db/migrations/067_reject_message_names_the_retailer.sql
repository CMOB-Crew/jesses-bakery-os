-- =====================================================================
-- Migration 067: the loader is retailer-generic; one message forgot.
--
-- jb_load_feed_upload() already handles all three retailers properly. It
-- resolves stores on
--
--     st.retailer = v_retailer and jb_norm_code_safe(st.supplier_code) = location
--
-- and products on the matching per-retailer column:
--
--     case v_retailer
--       when 'coles'       then p.coles_code
--       when 'woolworths'  then p.woolworths_code
--       when 'harris_farm' then p.harris_farm_code
--     end
--
-- Only the web layer was Coles-only, and that is being fixed alongside this.
--
-- But one reject message hardcodes the retailer's name:
--
--     'product code %s is ambiguous ... Someone has to say which one
--      Coles means before this row can load.'
--
-- Upload a Woolworths file with an ambiguous product code and the system
-- tells you to go and ask Coles. On a page whose entire purpose is that a
-- person can trust what it says about their data, a message that names the
-- wrong retailer is worse than no message.
--
-- Patches the LIVE definition rather than retyping the procedure, for the
-- reason 057, 062 and 064 all give: two copies of a function is how one of
-- them goes stale. Three guards -- it must exist, must not already be
-- patched, and the anchor must appear exactly once.
--
-- Idempotent. Refuses rather than guessing.
-- =====================================================================

\set ON_ERROR_STOP on

do $do$
declare
  v_src  text;
  v_new  text;
  v_hits int;
  v_old  text := 'Someone has to say which one Coles means before this row can load.';
  v_fix  text := 'Someone has to say which one %s means before this row can load.';
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'jb_load_feed_upload';

  if v_src is null then
    raise exception 'jb_load_feed_upload does not exist. Nothing changed.';
  end if;

  if position(v_old in v_src) = 0 then
    raise notice 'Already patched (or the message has changed). Nothing to do.';
    return;
  end if;

  v_hits := (length(v_src) - length(replace(v_src, v_old, ''))) / length(v_old);
  if v_hits <> 1 then
    raise exception 'Anchor appears % times, expected exactly 1. Refusing to guess.', v_hits;
  end if;

  -- The format() call this sits in currently passes three arguments for three
  -- placeholders. Adding a %s for the retailer means adding v_retailer as a
  -- fourth, in the position the new placeholder occupies -- LAST, because the
  -- new %s comes after the existing three.
  v_new := replace(v_src, v_old, v_fix);
  v_new := replace(
    v_new,
    'r.sell_item, r.n_products, r.names)',
    'r.sell_item, r.n_products, r.names, v_retailer)'
  );

  execute v_new;
  raise notice 'jb_load_feed_upload patched: ambiguous-product rejects now name the uploading retailer.';
end
$do$;

\echo ''
\echo '=== the message as it now stands ==='
select substring(pg_get_functiondef(p.oid)
                 from 'Someone has to say which one [^'']*')
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'jb_load_feed_upload';

\echo ''
\echo '=== sanity: the loader still resolves all three retailers ==='
select unnest(enum_range(null::retailer_type))::text as retailer;
