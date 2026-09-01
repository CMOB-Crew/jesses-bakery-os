-- Products carry a pack size. Trays were short by it.
--
-- Simona, 1 Sept, 34:10: "if we sold 400 bags of plain bagels, it's actually
-- 400 bags of five. So that's 2,000 bagels. So then divided by, is it 24 on a
-- tray? That means it's 83.3 trays."
--
-- The retailer scans the five-pack barcode, so a Coles row reads
-- "JESSE'S POPPYSEED BAGELS 5 | Sales Qty 2 | Std Unit Cost 4.93". Sales Qty
-- counts BAGS. store_reco carries that through unchanged, and the production
-- sheet then divided bags by 24 individual bagels per tray (migration 024).
-- Every multipack line was short by its pack size — 722 trays a week where the
-- floor bakes about 3,064.
--
-- The multiplier is Jesse's own naming: BAGEL - PLAIN (X 5),
-- MINI CHALLAH - PLAIN (X 4), BAGEL - MINI (X 6). Two independent checks in
-- the data agree with the name on every product that has volume: only
-- supermarkets buy the suffixed ones and a supermarket never buys a single,
-- and the per-unit price on the Coles feed is a bag price throughout
-- ($4.93 / $4.92 for the 5-packs, $4.40 for the 6-pack, $4.36 for the
-- 4-packs). Nothing in the catalogue is priced as a loose bagel.
--
-- The one line that looked wrong is not: BAGEL - MINI has 1,080 units with no
-- suffix, but it is invoice-only (coles 0, woolies 0, harris 0) — a real
-- loose-bagel SKU for the cafes, exactly as Simona described. Its six-pack
-- sibling BAGEL - MINI (X 6) sells to Coles and Harris Farm.
--
-- Default 1 is deliberate: an unrecognised name bakes the same as it does
-- today rather than multiplying by a guess.

alter table products
  add column if not exists pack_size int not null default 1;

comment on column products.pack_size is
  'Individual items in one sold unit. A Coles/Woolies/Harris sales qty of 1 is '
  'one of these. trays = ceil(units * pack_size / baking_qty). 1 = sold loose.';

update products
   set pack_size = (regexp_match(name, '\(X ?([0-9]+)\)'))[1]::int
 where name ~ '\(X ?[0-9]+\)'
   and pack_size is distinct from (regexp_match(name, '\(X ?([0-9]+)\)'))[1]::int;

alter table products
  drop constraint if exists products_pack_size_sane;
alter table products
  add constraint products_pack_size_sane check (pack_size between 1 and 24);
