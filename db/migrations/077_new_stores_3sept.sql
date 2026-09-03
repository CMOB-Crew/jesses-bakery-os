-- Migration 077: the 15 stores Simona sent on 3 September.
--
-- Source: Simona, "New Stores", 11:01 AEST 3 September 2026, accounts@ to Tommy
-- and Javonte. Fourteen NSW, one QLD, with a size against each.
--
-- WHAT WAS ALREADY IN THE SYSTEM. All fifteen numbers were checked against
-- stores.supplier_code and stores.retailer_store_id before a line was written:
--   * 8524 Wilton Plaza    -- present, inactive, size small, on the Canberra run
--   * 965  Coles Westmead  -- present, inactive, no size, Western Sydney run
--   * the other thirteen   -- not in the system at all
-- So this inserts thirteen and fills in two fields. Neither existing store is
-- re-added, and neither is moved.
--
-- WHY EVERY NEW STORE LANDS IN 'Unassigned' AND NOT A REAL REGION.
--
-- A region in this schema is not a suburb, it is a van. COLES NORTH SYDNEY sits
-- in NORTHERN BEACHES. WOOLWORTHS STRATHFIELD PLAZA sits in INNER WEST. The
-- Canberra run carries Goulburn, Queanbeyan, Yass, Oran Park and Wilton Plaza,
-- all NSW, because that is the road it drives. Reading a region off a store's
-- name is guessing which truck it rides.
--
-- None of these fifteen is supplied yet, so none of them has a truck. That is
-- what 'Unassigned' is for: it already holds stores with no run (IGA Supamart
-- Tramsheds) and deliberately has no run of its own. Simona picks the run and
-- the delivery days through New store at go-live, which is the screen that
-- exists for it and the only place that knows which van has room.
--
-- WHY QLD GETS ITS OWN HOLDING PEN. Tank St 2338 is the first Queensland store.
-- Dropping it in 'Unassigned' would file it under a region whose state is NSW,
-- and the dashboard, the production board and the stores list all scope on
-- stores.state -- so it would answer to the NSW filter and quietly move a NSW
-- total. 'QLD UNASSIGNED' mirrors 'Unassigned' exactly: no run, nothing
-- delivered from it, somewhere to stand until Somnath's QLD regions and runs
-- land (migration 023's note). No code change is needed for the filter: every
-- state picker in the app builds its options from the states actually present.
--
-- SIZES ARE SIMONA'S. Migration 007 seeded 'small' for the Metro format and said
-- it would be confirmed at go-live. This email is that confirmation, and it
-- disagrees in one place -- she has Wilton Plaza as Med where 007 guessed small.
-- Hers wins.
--
-- Additive and idempotent: every insert is guarded on (retailer, supplier_code),
-- every update on the value it is correcting.

begin;

-- ---------------------------------------------------------------------------
-- 1. The QLD holding pen. Same shape as 'Unassigned': a region with no run.
-- ---------------------------------------------------------------------------
insert into regions (name, state)
select 'QLD UNASSIGNED', 'QLD'
where not exists (select 1 from regions where upper(name) = 'QLD UNASSIGNED');

-- ---------------------------------------------------------------------------
-- 2. The thirteen new stores. Inactive, no run, no delivery days -- which is
--    the truth: supply has not started and no van has been picked.
-- ---------------------------------------------------------------------------
insert into stores (name, retailer, region_id, supplier_code, size_category, state, active)
select n.name,
       'woolworths'::retailer_type,
       (select id from regions where name = n.pen),
       n.supplier_code,
       n.size::store_size,
       n.st,
       false
from (values
        ('8964', 'Woolworths Metro Barangaroo',          'small',  'NSW', 'Unassigned'),
        ('1905', 'Woolworths Metro Central Park',        'medium', 'NSW', 'Unassigned'),
        ('1816', 'Woolworths Metro North Sydney',        'small',  'NSW', 'Unassigned'),
        ('1665', 'Woolworths Metro Parramatta Station',  'medium', 'NSW', 'Unassigned'),
        ('1638', 'Woolworths Metro Green Square',        'medium', 'NSW', 'Unassigned'),
        ('1577', 'Woolworths Metro Rozelle',             'medium', 'NSW', 'Unassigned'),
        ('1376', 'Woolworths Metro Maroubra Beach',      'medium', 'NSW', 'Unassigned'),
        ('1324', 'Woolworths Metro Erskineville',        'medium', 'NSW', 'Unassigned'),
        ('1319', 'Woolworths Metro Padstow',             'small',  'NSW', 'Unassigned'),
        ('1289', 'Woolworths Metro North Strathfield',   'medium', 'NSW', 'Unassigned'),
        ('1270', 'Woolworths Metro Kings Cross',         'medium', 'NSW', 'Unassigned'),
        ('1240', 'Woolworths Metro Cronulla',            'medium', 'NSW', 'Unassigned'),
        ('2338', 'Woolworths Metro Tank St',             'small',  'QLD', 'QLD UNASSIGNED')
     ) as n(supplier_code, name, size, st, pen)
where not exists (
  select 1 from stores s
   where s.retailer = 'woolworths'::retailer_type
     and s.supplier_code = n.supplier_code
);

-- ---------------------------------------------------------------------------
-- 3. Coles Westmead 965 is the fifteenth. It is already here as a Coles store
--    on the Western Sydney run with retailer_store_id STO291, so it is not
--    inserted -- only the size Simona has now given it is filled in, and only
--    if it is still empty.
-- ---------------------------------------------------------------------------
update stores
   set size_category = 'small'::store_size
 where supplier_code = '965'
   and retailer = 'coles'::retailer_type
   and size_category is null;

-- ---------------------------------------------------------------------------
-- 4. Wilton Plaza 8524 is the other one already here. Simona has it as Med.
--
--    Its REGION is deliberately left alone. It looks wrong -- a NSW store in a
--    region called CANBERRA -- and the first version of this migration moved
--    it. That was checked before shipping and the check said no: the Canberra
--    run also carries Goulburn, Queanbeyan, Yass, Jerrabomberra and Oran Park,
--    every one of them NSW, and Wilton Plaza already has that run and its
--    {tue,fri} days. It is on the road to Canberra, which is the point.
--
--    The one thing that region does change is ranging: New store strips rye,
--    dark rye and mini challah from any Woolworths store whose region matches
--    /canberra|\bact\b/. Measured over the last 90 days, the ten other
--    Woolworths stores on that run sold 56 units of those lines between them --
--    about two a store a month. The rule is not costing this store anything
--    worth breaking the run grouping for.
-- ---------------------------------------------------------------------------
update stores
   set size_category = 'medium'::store_size
 where supplier_code = '8524'
   and retailer = 'woolworths'::retailer_type
   and size_category = 'small'::store_size;

commit;

-- Verify:
--   select s.supplier_code, s.name, s.state, s.size_category, s.active,
--          r.name as region, s.default_run_id
--     from stores s left join regions r on r.id = s.region_id
--    where s.supplier_code in ('8964','1905','1816','1665','1638','1577','1376',
--                              '1324','1319','1289','1270','1240','2338','8524','965')
--    order by s.state, s.supplier_code;
--   -- expect 15 rows, all active = false, 14 NSW + 1 QLD, every one with a size.
