-- Data load: named delivery runs + their days.
-- Source: Simona's confirmed Region Delivery Schedule (Tab 2 of the "Confirm This"
-- workbook, 11 Aug) — cross-checked against the per-store delivery days in the
-- 21 Aug Stores Master (they match). In her operation the region IS the run, so we
-- create one run per region, named by the region, with the confirmed delivery days.
-- This is what powers "pick a run -> its days auto-fill" in the New Store wizard,
-- replacing the old "Run 1..8" numbers Simona found confusing.
--
-- runs.run_days is weekday[] ('mon'..'sun'). Idempotent: upsert on (region_id, name).
-- Region names in this DB are UPPERCASE; run names are title-cased (initcap).

insert into runs (region_id, name, run_days)
select r.id, initcap(r.name), v.days::weekday[]
from regions r
join (values
  ('CANBERRA',         array['tue','fri']),
  ('CENTRAL COAST',    array['mon','wed','sat']),
  ('CITY',             array['mon','wed','fri']),
  ('EASTERN SUBURBS',  array['mon','tue','wed','thu','fri','sat','sun']),
  ('HILLS',            array['mon','wed','sat']),
  ('INNER WEST',       array['mon','wed','fri','sat']),
  ('NEWCASTLE',        array['tue','thu','sat']),
  ('NORTH SHORE',      array['tue','thu','fri','sat','sun']),
  ('NORTH WEST',       array['mon','wed','fri','sat']),
  ('NORTHERN BEACHES', array['tue','thu','fri','sat','sun']),
  ('SCHOOLS',          array['fri']),
  ('SOUTH',            array['mon','wed','sat']),
  ('SOUTH EAST',       array['tue','thu','sun']),
  ('WESTERN SYDNEY',   array['mon','thu','sat'])
) as v(region, days) on upper(r.name) = v.region
on conflict (region_id, name) do update set run_days = excluded.run_days;

-- Verify: each run with its days + store count
select rn.name, rn.run_days, count(s.id) as stores
from runs rn
join regions r on r.id = rn.region_id
left join stores s on s.region_id = r.id and s.active
group by rn.name, rn.run_days order by rn.name;
