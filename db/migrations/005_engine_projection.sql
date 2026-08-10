-- Migration 005: engine_projection — real 32%->X% waste projection (Woolworths mature feed)
-- Source: newsvendor order-up-to on real delivered-vs-sold ledger (10 Aug 2026).
create table if not exists engine_projection (
  scenario text primary key,
  label text not null,
  ord int not null,
  waste_pct numeric(5,1),
  lost_sales_pct numeric(5,1),
  units_saved_wk int not null default 0,
  delivered int,
  channel text not null default 'woolworths'
);
truncate engine_projection;
insert into engine_projection(scenario,label,ord,waste_pct,lost_sales_pct,units_saved_wk,delivered) values
  ('current','Current system',0,32.5,null,0,17524),
  ('lean','Lean (waste-first)',1,19.1,10.4,3190,13099),
  ('balanced','Balanced',2,22.5,7.2,2493,14179),
  ('service','Service-leaning',3,26.9,4.5,1532,15461);
