-- Migration 007: seed 5 new Woolworths Metro Canberra stores (INACTIVE)
-- Source: Simona, 14 Aug 2026 ("RE: QLD stores"):
--   "These are new Woolworths Metro Canberra stores — can add them on but make
--    them inactive for now as we haven't started supplying yet. Will start in
--    2-3 weeks."
--
-- Notes:
--  * supplier_code = the Woolworths Location number (the key that maps a store
--    to its retailer sales report — same field Fred's Invoice_Cost extract joins
--    on). retailer_store_id (the scan-system STOxxx id) is left null; the store
--    hasn't been onboarded to the scan system yet.
--  * region bound by state = 'ACT' (falls back to a name match on 'canberra'),
--    so it attaches to the real ACT region whatever its exact display name.
--  * size_category defaults to 'small' — the Woolworths Metro format — and is
--    confirmed at go-live via New store.
--  * active = false. They stay out of the live network counts until supply
--    starts; flip active = true (and set onboarded_at) when they go live.
--  * Idempotent: re-running skips any store already present by
--    (retailer, supplier_code). Safe to apply more than once.

insert into stores (name, retailer, region_id, supplier_code, size_category, active)
select n.name,
       'woolworths'::retailer_type,
       a.rid,
       n.supplier_code,
       'small'::store_size,
       false
from (values
        ('1457', 'Woolworths Metro Bonner'),
        ('1610', 'Woolworths Metro Wright'),
        ('1661', 'Woolworths Metro Franklin'),
        ('1089', 'Woolworths Metro Hawker'),
        ('8524', 'Woolworths Metro Wilton Plaza')
     ) as n(supplier_code, name)
left join (
  select id as rid
  from regions
  where state = 'ACT' or name ilike '%canberra%'
  order by created_at
  limit 1
) a on true
where not exists (
  select 1 from stores s
  where s.retailer = 'woolworths'::retailer_type
    and s.supplier_code = n.supplier_code
);

-- Verify after apply:
--   select name, supplier_code, active, region_id
--   from stores where supplier_code in ('1457','1610','1661','1089','8524')
--   order by supplier_code;
