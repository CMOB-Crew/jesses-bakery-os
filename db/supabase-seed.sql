-- =====================================================================
-- Jesse's Bakery OS — compact server-side seed (hosted Postgres / Supabase)
--
-- Generates the whole 84-store network inside the database. The fact
-- generation lives inside a single DO block so the whole thing runs as ONE
-- statement — Supabase's SQL editor can't lose the worktable between steps.
-- Deterministic-ish via setseed(); safe to re-run (truncates first).
-- =====================================================================
truncate wastage, delivery_items, deliveries, on_hand_ledger, sales_daily,
         replenishment_plans, feed_status_log, events, stores, runs, regions,
         product_prices, products, pricing_tiers, app_users restart identity cascade;
select setseed(0.42);

insert into pricing_tiers(name) values ('Coles'),('Woolworths'),('Harris Farm'),('Cafe'),('Distributor');

insert into products(name,category,is_core,lead_time_days,shelf_life_days,min_on_shelf) values
  ('White Sourdough','sourdough',true,2,5,2),
  ('Rye Sourdough','sourdough',false,2,5,2),
  ('Plain Bagel','bagel',true,1,4,2),
  ('Sesame Bagel','bagel',false,1,4,2),
  ('Poppy Bagel','bagel',false,1,4,2),
  ('Mini Challah','challah',false,1,3,2),
  ('Pita','pita',false,1,7,3);

insert into app_users(full_name,email,role,department) values
  ('Simona','simona@jessesbakery.com.au','ops','Operations'),
  ('Jesse','jesse@jessesbakery.com.au','admin','Owner'),
  ('Dan Kelly','dan@jessesbakery.com.au','driver','Logistics'),
  ('Mike Rowe','mike@jessesbakery.com.au','driver','Logistics'),
  ('Ana Silva','ana@jessesbakery.com.au','packer','Bakery');

insert into regions(name,state) values
  ('Eastern Suburbs','NSW'),('Inner West','NSW'),('City','NSW'),('North Shore','NSW'),
  ('South','NSW'),('Northern Beaches','NSW'),('Hills','NSW'),('Western Sydney','NSW'),
  ('Canberra','ACT'),('Central Coast','NSW'),('Newcastle','NSW'),('Northwest','NSW');

insert into runs(region_id,name,run_days)
  select id, name||' run', '{mon,tue,wed,thu,fri,sat,sun}'::weekday[] from regions;

with mk as (
  select r.id region_id, r.name region_name, gs.i,
         row_number() over (order by r.name, gs.i) rn,
         random() rsize, random() rret, random() rprob
  from regions r cross join generate_series(1,7) gs(i)
)
insert into stores(name,retailer,region_id,default_run_id,size_category,shelf_min,shelf_max,
  retailer_store_id,supplier_code,xero_contact_id,pricing_tier_id,postcode,onboarded_at)
select
  (case when rret<0.34 then 'Coles' when rret<0.67 then 'Woolworths' else 'Harris Farm' end)||' '||region_name||' '||i,
  (case when rret<0.34 then 'coles' when rret<0.67 then 'woolworths' else 'harris_farm' end)::retailer_type,
  region_id,
  (select id from runs where runs.region_id = mk.region_id limit 1),
  (case when rsize<0.34 then 'small' when rsize<0.74 then 'medium' else 'large' end)::store_size,
  5,
  (case when rsize<0.34 then 45 when rsize<0.74 then 75 else 150 end),
  'STO'||(100+rn),
  (100+floor(rret*899))::text,
  gen_random_uuid()::text,
  (select id from pricing_tiers pt where pt.name = (case when rret<0.34 then 'Coles' when rret<0.67 then 'Woolworths' else 'Harris Farm' end)),
  (2000+floor(rsize*914))::text,
  current_date - (120+floor(rprob*700))::int
from mk;

-- ---- facts + all fact tables, generated inside ONE statement ----------
do $$
begin
  create temp table _facts as
  with d3 as (
    select
      s.id store_id, p.id product_id, s.retailer, s.shelf_max, s.default_run_id, p.min_on_shelf,
      g.d::date sale_date,
      (case s.size_category when 'small' then 8.0 when 'medium' then 18.0 when 'large' then 34.0 else 14.0 end)
        * (0.8 + (('x'||substr(md5(s.id::text),1,4))::bit(16)::int % 100)/250.0) as sbase,
      (case p.category when 'sourdough' then 1.0 when 'bagel' then 0.7 when 'challah' then 0.4 else 0.5 end) as pop,
      (case extract(dow from g.d)::int when 0 then 1.4 when 6 then 1.55 when 5 then 1.3
            when 4 then 1.0 when 3 then 0.95 else 0.85 end) as dmult,
      (('x'||substr(md5(s.id::text),5,2))::bit(8)::int % 100) as sh,
      (('x'||substr(md5(s.id::text||p.id::text||g.d::text),1,4))::bit(16)::int % 100) as noise
    from stores s
    cross join products p
    cross join generate_series(current_date - 41, current_date, interval '1 day') g(d)
  ),
  d4 as (
    select *,
      greatest(0, round(sbase * pop * dmult * (0.82 + noise/330.0)))::int as demand,
      (1.12 + (sh % 16)/100.0 + case when sh < 9 then 0.75 else 0 end) as overs
    from d3
  )
  select store_id, product_id, retailer, shelf_max, default_run_id, min_on_shelf, sale_date, demand,
         least(shelf_max, greatest(min_on_shelf, round(sbase * pop * dmult * overs)::int)) as sent
  from d4;

  create temp table _drv as select id, row_number() over () rn from app_users where role='driver';

  insert into deliveries(id, store_id, run_id, driver_id, delivery_date, status, delivered_at)
  select distinct md5(store_id::text||sale_date::text)::uuid, store_id, default_run_id,
         (select id from _drv where rn = 1 + (('x'||substr(md5(store_id::text),1,2))::bit(8)::int % 2)),
         sale_date, 'delivered'::delivery_status, sale_date
  from _facts;

  insert into delivery_items(delivery_id, product_id, qty_sent, qty_delivered)
  select md5(store_id::text||sale_date::text)::uuid, product_id, sent, sent from _facts;

  insert into sales_daily(store_id, product_id, sale_date, units_sold, source)
  select store_id, product_id, sale_date, least(demand, sent), retailer from _facts;

  insert into wastage(store_id, product_id, waste_date, qty, captured_by)
  select store_id, product_id, sale_date, round(greatest(sent - demand, 0) * 0.55)::int,
         (select id from _drv where rn=1)
  from _facts where round(greatest(sent - demand, 0) * 0.55)::int > 0;

  insert into on_hand_ledger(store_id, product_id, as_of_date, opening_on_hand, delivered, sold, expired, closing_on_hand)
  select store_id, product_id, sale_date, 0, sent, least(demand, sent),
         round(greatest(sent - demand, 0) * 0.55)::int,
         greatest(sent - demand, 0) - round(greatest(sent - demand, 0) * 0.55)::int
  from _facts;

  drop table _facts;
  drop table _drv;
end $$;

-- ---- feed health + events ------------------------------------------
insert into feed_status_log(source, as_of, status, detail) values
  ('coles', current_date, 'ok', 'current'),
  ('woolworths', current_date, 'ok', 'current'),
  ('harris_farm', current_date - 2, 'stale', 'last loaded 2 days ago');

insert into events(name, kind, state, start_date, end_date, uplift_pct) values
  ('Christmas','retail_event',null, make_date(extract(year from current_date)::int,12,18), make_date(extract(year from current_date)::int,12,24), 40),
  ('Easter','public_holiday',null, make_date(extract(year from current_date)::int,4,3), make_date(extract(year from current_date)::int,4,6), 25),
  ('NSW School Holidays','school_holiday','NSW', make_date(extract(year from current_date)::int,7,1), make_date(extract(year from current_date)::int,7,14), -15);

select 'seeded' as status,
       (select count(*) from stores) as stores,
       (select count(*) from sales_daily) as sales_rows,
       (select waste_pct from v_network_week) as network_waste_pct;
