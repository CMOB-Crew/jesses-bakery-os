-- Data load: the 14 Aug ranging anomalies (Simona, "QLD stores" email).
-- Marks specific (store, product) lines as NOT ranged, so migration 021's
-- ranging-aware v_store_week stops counting them as sent-but-unsold. This is what
-- makes Mascot DC stop looking like a dud and the ACT Woolworths waste read true.
--
-- Writes to store_product_ranging (migration 015) with ranged = false. Absence of
-- a row = ranged (default), so nothing else is touched. ON CONFLICT re-asserts, so
-- re-running is safe. Uses ILIKE name patterns (not hard-coded IDs) so it survives
-- exact-name differences. RUN THE TWO PREVIEW SELECTS FIRST and eyeball the counts.
--
-- Variances (verbatim from the email):
--   All WW in ACT: no Rye sourdough, Dark Rye, Mini challah (all), Large challah (all).
--   WW Mascot DC: no sesame mini challah (all), dark rye, spelt sourdough, pita, challah (all).
--   Coles Bondi Westfield (853): has EXTRA mini bagels + pita ranged — that's an
--     ADD, and ranged = true is already the default, so it needs no row here.

-- ============================ PREVIEW 1: ACT Woolworths ============================
-- Expect ~13 ACT WW stores × the 4 product groups. Check the store + product lists.
select st.name as store, reg.name as region, p.name as product_unranged
from stores st
join regions reg on reg.id = st.region_id
join products p on (
      p.name ilike '%rye sourdough%'
   or p.name ilike '%dark rye%'
   or p.name ilike '%mini challah%'
   or (p.name ilike '%challah%' and p.name not ilike '%mini%')
)
where st.retailer = 'woolworths'
  and reg.name ilike '%canberra%'     -- ACT region (workbook labels ACT stores "Canberra")
order by st.name, p.name;

-- ============================ PREVIEW 2: WW Mascot DC ============================
-- Expect 1 store (the Mascot DC) × 5 product groups.
select st.name as store, p.name as product_unranged
from stores st
join products p on (
      (p.name ilike '%mini challah%' and p.name ilike '%sesame%')
   or p.name ilike '%dark rye%'
   or p.name ilike '%spelt%'
   or p.name ilike '%pita%'
   or (p.name ilike '%challah%' and p.name not ilike '%mini%')
)
where st.retailer = 'woolworths'
  and st.name ilike '%mascot%'
order by st.name, p.name;

-- ============================ APPLY (run after previews look right) ============================
begin;

-- ACT Woolworths
insert into store_product_ranging (store_id, product_id, ranged, updated_by)
select st.id, p.id, false, 'ranging-14aug'
from stores st
join regions reg on reg.id = st.region_id
join products p on (
      p.name ilike '%rye sourdough%'
   or p.name ilike '%dark rye%'
   or p.name ilike '%mini challah%'
   or (p.name ilike '%challah%' and p.name not ilike '%mini%')
)
where st.retailer = 'woolworths'
  and reg.name ilike '%canberra%'
on conflict (store_id, product_id)
  do update set ranged = false, updated_by = 'ranging-14aug', updated_at = now();

-- WW Mascot DC
insert into store_product_ranging (store_id, product_id, ranged, updated_by)
select st.id, p.id, false, 'ranging-14aug'
from stores st
join products p on (
      (p.name ilike '%mini challah%' and p.name ilike '%sesame%')
   or p.name ilike '%dark rye%'
   or p.name ilike '%spelt%'
   or p.name ilike '%pita%'
   or (p.name ilike '%challah%' and p.name not ilike '%mini%')
)
where st.retailer = 'woolworths'
  and st.name ilike '%mascot%'
on conflict (store_id, product_id)
  do update set ranged = false, updated_by = 'ranging-14aug', updated_at = now();

commit;

-- Verify: how many un-range rows we now hold, by store
select st.name, count(*) as unranged_lines
from store_product_ranging r
join stores st on st.id = r.store_id
where r.ranged = false and r.updated_by = 'ranging-14aug'
group by st.name order by st.name;
