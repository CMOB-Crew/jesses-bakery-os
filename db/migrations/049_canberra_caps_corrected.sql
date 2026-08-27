-- =====================================================================
-- Migration 049: correct the shelf caps 048 just set. They are too high, and
-- the mistake is mine.
--
-- WHAT 048 DID, AND WHY IT IS WRONG
--
-- All five stores already carried size_category = 'small' before 048 ran. 048
-- then set shelf_min 60 / shelf_max 90 on them, taken from the median of every
-- active Woolworths METRO store nationally.
--
-- Two problems with that:
--
-- 1. It ignored SIZE. Metro is a store format; small/medium/large is the shelf
--    band Simona actually confirmed and the one every waste threshold is keyed
--    to. Taking a national Metro median mixes mediums in and pulls the cap up.
--
-- 2. It contradicts the client. Simona's own new-store guidance, by email on
--    14 Aug: a small store is "50-60" units baseline. A cap of 90 on a store
--    the system itself calls small is not a small store's cap.
--
-- The only active Woolworths store in the ACT with a cap is BELCONNEN, and it
-- is a MEDIUM at 50/60. So even the closest geographic peer sits below what
-- 048 wrote for five stores it classed as smaller than Belconnen.
--
-- 048's own header said to check the derived cap against Simona's 50-60 band
-- and ask rather than ship it if it landed outside. It landed outside. The
-- report printed the ACT peer list rather than the national Metro list the
-- number actually came from, which made the mismatch easy to miss — also mine.
--
-- WHAT THIS DOES
--
-- Re-derives from active Woolworths stores of the SAME SIZE BAND, which is the
-- comparison that matches how the rest of the system reasons about shelves. If
-- there is no same-size peer it refuses and says so rather than writing a
-- second undefendable number.
--
-- The stores stay INACTIVE. 048's snapshot in jb_store_backup_048 still holds
-- the ORIGINAL pre-048 values (nulls), so the undo path is unchanged.
-- =====================================================================

\set ON_ERROR_STOP on

create temporary view _five as
  select id, size_category from stores
   where supplier_code in ('1457','1610','1661','1089','8524');

\echo ''
\echo '=== the same-size peers this will actually use ==='
select s.size_category,
       count(*)                                                        as peers,
       min(p.shelf_max)                                                as min_cap,
       percentile_cont(0.5) within group (order by p.shelf_max)::int   as median_cap,
       max(p.shelf_max)                                                as max_cap
  from (select distinct size_category from _five) s
  join stores p
    on p.active and p.retailer = 'woolworths'
   and p.size_category = s.size_category and p.shelf_max is not null
 group by s.size_category;

update stores s
   set shelf_max = peer.med_max,
       shelf_min = coalesce(peer.med_min, s.shelf_min)
  from _five f,
       lateral (
         select percentile_cont(0.5) within group (order by p.shelf_max)::int as med_max,
                percentile_cont(0.5) within group (order by p.shelf_min)::int as med_min,
                count(*) as n
           from stores p
          where p.active and p.retailer = 'woolworths'
            and p.size_category = f.size_category
            and p.shelf_max is not null
       ) peer
 where s.id = f.id and peer.n > 0;

\echo ''
\echo '=== the five, corrected (still INACTIVE) ==='
select s.supplier_code, s.name, s.active, s.state,
       array_to_string(s.delivery_days::text[], ',') as delivery_days,
       s.size_category, s.shelf_min, s.shelf_max
  from stores s join _five f on f.id = s.id
 order by s.supplier_code;

\echo ''
\echo '=== sanity: how every OTHER small Woolworths store is capped ==='
select shelf_min, shelf_max, count(*) as stores
  from stores
 where active and retailer = 'woolworths' and size_category = 'small'
   and shelf_max is not null
 group by 1,2 order by 3 desc;

\echo ''
\echo 'Simona, 14 Aug: a small store is "50-60" units baseline. If the corrected'
\echo 'cap above is still far outside that, do not activate these on Tuesday —'
\echo 'send me the numbers and it becomes a question for her, not a guess.'

-- Undo (back to pre-048 nulls):
--   update stores s
--      set state = b.state, delivery_days = b.delivery_days,
--          shelf_min = b.shelf_min, shelf_max = b.shelf_max,
--          size_category = b.size_category
--     from jb_store_backup_048 b where b.store_id = s.id;
