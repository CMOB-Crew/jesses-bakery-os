-- Data load: the 14 Aug ranging anomalies (Simona, "QLD stores" email).
-- APPLIED to live Supabase 21 Aug 2026 via the SQL editor.
--
-- Marks specific (store, product) lines as NOT ranged, so migration 021's
-- ranging-aware v_store_week stops counting them as sent-but-unsold. Writes to
-- store_product_ranging (migration 015) with ranged = false; absence of a row =
-- ranged (default). ON CONFLICT re-asserts, so re-running is safe.
--
-- IMPORTANT: patterns are matched against the REAL product taxonomy in this DB
-- (SOURDOUGH – RYE, SOURDOUGH – SPELT, DARK RYE [category other], MINI CHALLAH – %,
-- MEDIUM CHALLAH – %, CHALLAH – % [large loaves], PITA – %). The supermarket-facing
-- names in Simona's email ("Jesse's Rye Sourdough 900g") do NOT appear here, so we
-- map by category + keyword, not by the email's product strings.
--
-- Mapping applied:
--   Rye sourdough      -> category sourdough + name ILIKE '%rye%'   (= SOURDOUGH – RYE)
--   Spelt sourdough    -> category sourdough + name ILIKE '%spelt%' (= SOURDOUGH – SPELT)
--   Dark rye           -> name ILIKE '%dark rye%'                   (= DARK RYE, category other)
--   Mini challah (all) -> name ILIKE 'MINI CHALLAH%'                (all mini challah SKUs)
--   Sesame mini challah-> name ILIKE 'MINI CHALLAH%' and '%sesame%'
--   Large challah (all)-> category challah + name ILIKE 'CHALLAH %' and NOT '%dough%'
--                         (the large CHALLAH – % loaves; excludes MINI/MEDIUM/dough balls)
--   Pita               -> category pita                            (all PITA – % SKUs)
--
-- Scope: "All WW in ACT" = retailer woolworths + region ILIKE '%canberra%' (20 stores,
--   19 lines each). "WW Mascot DC" = ONLY the store named '%mascot dc%' (there is also a
--   regular WOOLWORTHS MASCOT which must NOT be touched). Result: 21 stores, 399 rows.
--   Coles Bondi Westfield (853) "extra mini bagels + pita" is an ADD (default ranged) — no row.

begin;

-- ACT Woolworths: no rye sourdough, dark rye, mini challah (all), large challah (all)
insert into store_product_ranging (store_id, product_id, ranged, updated_by)
select st.id, p.id, false, 'ranging-14aug'
from stores st join regions reg on reg.id = st.region_id
join products p on (
     (p.category = 'sourdough' and p.name ilike '%rye%')
  or p.name ilike '%dark rye%'
  or p.name ilike 'mini challah%'
  or (p.category = 'challah' and p.name ilike 'challah %' and p.name not ilike '%dough%')
)
where st.retailer = 'woolworths' and reg.name ilike '%canberra%'
on conflict (store_id, product_id)
  do update set ranged = false, updated_by = 'ranging-14aug', updated_at = now();

-- WW Mascot DC ONLY: no sesame mini challah, dark rye, spelt sourdough, pita, challah (all)
insert into store_product_ranging (store_id, product_id, ranged, updated_by)
select st.id, p.id, false, 'ranging-14aug'
from stores st join products p on (
     (p.name ilike 'mini challah%' and p.name ilike '%sesame%')
  or p.name ilike '%dark rye%'
  or (p.category = 'sourdough' and p.name ilike '%spelt%')
  or p.category = 'pita'
  or (p.category = 'challah' and p.name ilike 'challah %' and p.name not ilike '%dough%')
)
where st.retailer = 'woolworths' and st.name ilike '%mascot dc%'
on conflict (store_id, product_id)
  do update set ranged = false, updated_by = 'ranging-14aug', updated_at = now();

commit;

-- Verify:
--   select st.name, count(*) from store_product_ranging r join stores st on st.id=r.store_id
--   where r.updated_by='ranging-14aug' and r.ranged=false group by st.name order by st.name;
--   -- 20 ACT Woolworths + WOOLWORTHS MASCOT DC, 19 lines each.
