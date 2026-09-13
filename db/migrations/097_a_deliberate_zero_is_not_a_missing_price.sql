-- ---------------------------------------------------------------------------
-- 097  A DELIBERATE ZERO IS NOT A MISSING PRICE.
--
-- JESSE'S CAFE cannot be invoiced. 59 of its ordered lines have no price, so
-- buildInvoice() refuses the whole customer -- measured on production on
-- 14 September with what-would-refuse-to-bill.sh. It is one of only two
-- customers out of fifty that refuses for a reason that is not "they order
-- nothing".
--
-- WHY IT HAS NO PRICES, AND WHY THAT WAS A REASONABLE MISTAKE
--
-- legacy-load/build_price_load.py, in its own header:
--
--     ZERO PRICES ARE NOT IMPORTED. 1,261 of the 1,911 lines are 0.00. A zero
--     in a price list means "nobody has recorded a price", not "this customer
--     gets it free"... "No price recorded" and "free" are different facts and
--     only one of them is true.
--
-- That is good reasoning and it is right for most of those 1,261 lines. It is
-- wrong for this one customer, and there was no way to know at the time --
-- nobody had seen a real invoice until @Fred pulled one out of Jesse's Data
-- Factory on 11 September:
--
--     244 of the 725 lines are $0 - concentrated in 2 stores, and Jesse's Cafe
--     is entirely $0. His own shop, deliberate. Not a data problem.
--
-- So for JESSE'S CAFE the zero IS the price. It is Jesse's own shop, it has
-- been invoiced at $0 every week since May 2025, and all 93 of its rows in the
-- legacy price list are 0.00 with no exceptions.
--
-- WHAT THIS DOES
--
-- Loads those 93 lines at unit_price = 0, carrying the legacy Xero code.
-- buildInvoice() already treats this correctly: it refuses on a NULL price and
-- 0 is not NULL, so the customer bills at $0 exactly as production does.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
--   * It does not touch the other 1,168 zero lines. The load's rule still
--     holds everywhere else: a zero for a customer who should be paying is a
--     missing price, and billing them $0 would be worse than refusing.
--   * It does not touch KORMEHL EMANUEL PRESCHOOL, which is the other customer
--     refusing for a real reason (2 ordered lines, no price, 31 zero rows in
--     the legacy list). @Fred said the $0 lines are concentrated in TWO stores
--     and named only Jesse's Cafe. Kormehl is the obvious candidate and it is
--     NOT CONFIRMED, and billing a preschool $0 on a guess is not a thing to
--     do quietly. Asked on 14 September; it gets its own migration when the
--     answer lands.
--   * It does not overwrite an existing price. ON CONFLICT DO NOTHING, so a
--     real price somebody has set since beats an imported zero.
--
-- Idempotent, and reversible in one line:
--
--     delete from store_product_prices where source = 'legacy-zero';
-- ---------------------------------------------------------------------------

-- 'legacy-zero' is its own source so these rows are traceable, and so a re-run
-- of the legacy price import cannot silently take them back -- 073b only
-- updates rows where source = 'legacy'.
alter table store_product_prices
  drop constraint if exists store_product_prices_source_check;

alter table store_product_prices
  add constraint store_product_prices_source_check
  check (source in ('legacy', 'manual', 'legacy-zero'));

comment on column store_product_prices.source is
  'legacy = came across in the 073b import of the old price list. manual = set by someone in the app since. legacy-zero = a price of 0.00 in the legacy list that is DELIBERATE rather than missing, loaded by migration 097 for JESSE''S CAFE only, on the evidence of a real legacy invoice. Everywhere else a zero is still treated as no price and the invoice refuses.';

with legacy(legacy_store, legacy_product, product_name, xero_code) as (
  values
  ('STO001', 'PRO001', '100GR CHALLAH DOUGH BALLS', 'Dough Balls 100GM'),
  ('STO001', 'PRO004', 'BABKAS - CHOCOLATE', 'Bubka'),
  ('STO001', 'PRO005', 'BABKAS - CINNAMON', 'Bubka'),
  ('STO001', 'PRO006', 'BAGEL - GLUTEN FREE', 'Bagel single'),
  ('STO001', 'PRO008', 'BAGEL - MINI', 'Bagel Mini'),
  ('STO001', 'PRO009', 'BAGEL - MINI (X 6)', 'Bagel Mini 6 Pack'),
  ('STO001', 'PRO010', 'BAGEL - MIXED SEEDS', 'Bagel single'),
  ('STO001', 'PRO011', 'BAGEL - MIXED SEEDS X 5', 'Bagel 5 Pack'),
  ('STO001', 'PRO012', 'BAGEL - PLAIN', 'Bagel single'),
  ('STO001', 'PRO013', 'BAGEL - PLAIN X 3', 'Bagel single'),
  ('STO001', 'PRO014', 'BAGEL - PLAIN X 5', 'Bagel 5 Pack'),
  ('STO001', 'PRO015', 'BAGEL - POPPY SEED', 'Bagel single'),
  ('STO001', 'PRO016', 'BAGEL - POPPY SEED X 5', 'Bagel 5 Pack'),
  ('STO001', 'PRO017', 'BAGEL - RAISIN', 'Bagel single'),
  ('STO001', 'PRO018', 'BAGEL - SESAME', 'Bagel single'),
  ('STO001', 'PRO019', 'BAGEL - SESAME X 5', 'Bagel 5 Pack'),
  ('STO001', 'PRO020', 'BAGEL - WHOLEMEAL', 'Bagel single'),
  ('STO001', 'PRO022', 'BAGEL - ZATAR', 'Bagel single'),
  ('STO001', 'PRO023', 'BAGUETTES', 'Baguette'),
  ('STO001', 'PRO028', 'BURGER BUNS - PLAIN', 'Burger Bun'),
  ('STO001', 'PRO029', 'BURGER BUNS - SEEDED', 'Burger Bun'),
  ('STO001', 'PRO030', 'CHALLAH - KOSHERLICIOUS', 'Challah Large'),
  ('STO001', 'PRO031', 'CHALLAH - GLUTEN FREE', 'Challah Large'),
  ('STO001', 'PRO032', 'CHALLAH - POPPY', 'Challah Large'),
  ('STO001', 'PRO033', 'CHALLAH - RAISIN', 'Challah Large'),
  ('STO001', 'PRO034', 'CHALLAH - RYE', 'Challah Large'),
  ('STO001', 'PRO035', 'CHALLAH - SEMISWEET SESAME', 'Challah Large'),
  ('STO001', 'PRO036', 'CHALLAH - SEMISWEET PLAIN', 'Challah Large'),
  ('STO001', 'PRO037', 'CHALLAH - SEMISWEET POPPY', 'Challah Large'),
  ('STO001', 'PRO038', 'CHALLAH - SOURDOUGH', 'Challah Large'),
  ('STO001', 'PRO039', 'CHALLAH - SPELT', 'Challah Large'),
  ('STO001', 'PRO040', 'CHALLAH - WATER', 'Challah Large'),
  ('STO001', 'PRO041', 'CHALLAH - WHOLEMEAL', 'Challah Large'),
  ('STO001', 'PRO042', 'CHALLAH DOUGH (1 KG BAGS)', 'Challah Dough'),
  ('STO001', 'PRO043', 'CHEESE POCKETS', 'Cheese pocket'),
  ('STO001', 'PRO044', 'CHIFFON - CHOCOLATE', 'Chiffon'),
  ('STO001', 'PRO046', 'CHIFFON - VANILLA', 'Chiffon'),
  ('STO001', 'PRO047', 'CROISSANTS - ALMOND', 'Croissant Regular'),
  ('STO001', 'PRO048', 'CROISSANTS - CHOCOLATE', 'Croissant Chocolate'),
  ('STO001', 'PRO049', 'CROISSANTS - PLAIN', 'Croissant Regular'),
  ('STO001', 'PRO050', 'DANISH - APPLE', 'Danish'),
  ('STO001', 'PRO051', 'DANISH - CHERRY', 'Danish'),
  ('STO001', 'PRO052', 'DANISH - APRICOT', 'Danish'),
  ('STO001', 'PRO053', 'DANISH - BLUEBERRY', 'Danish'),
  ('STO001', 'PRO054', 'DARK RYE', 'Dark Rye'),
  ('STO001', 'PRO056', 'DONUTS - CINNAMON', 'Donut'),
  ('STO001', 'PRO058', 'DONUTS - ICED', 'Donut'),
  ('STO001', 'PRO060', 'DONUTS - JAM', 'Donut'),
  ('STO001', 'PRO061', 'DONUTS - JAM (X 4)', ''),
  ('STO001', 'PRO064', 'GLUTEN FREE LOAVES', 'Gluten Free Bread Loaf'),
  ('STO001', 'PRO065', 'LOG CAKE - CHOCOLATE', 'Log Cake'),
  ('STO001', 'PRO066', 'LOG CAKE - MARBLE', 'Log Cake'),
  ('STO001', 'PRO067', 'LOG CAKE - VANILLA', 'Log Cake'),
  ('STO001', 'PRO068', 'LOG CAKE - HONEY', ''),
  ('STO001', 'PRO069', 'MEDIUM CHALLAH - PLAIN', 'Challah Medium'),
  ('STO001', 'PRO070', 'MEDIUM CHALLAH - POPPY', 'Challah Medium'),
  ('STO001', 'PRO071', 'MEDIUM CHALLAH - SESAME', 'Challah Medium'),
  ('STO001', 'PRO072', 'MEDIUM CHALLAH - WATER', 'Challah Medium'),
  ('STO001', 'PRO073', 'MEDIUM CHALLAH - WHOLEMEAL', 'Challah Medium'),
  ('STO001', 'PRO075', 'MINI CHALLAH - PLAIN X 4', 'Challah Mini 4 Pack'),
  ('STO001', 'PRO076', 'MINI CHALLAH - KOSHERLICIOUS', 'Challah Mini 4 Pack'),
  ('STO001', 'PRO078', 'MINI CHALLAH - SESAME X 4', 'Challah Mini 4 Pack'),
  ('STO001', 'PRO079', 'MUFFINS - APPLE', 'Muffin'),
  ('STO001', 'PRO080', 'MUFFINS - BLUEBERRY', 'Muffin'),
  ('STO001', 'PRO081', 'MUFFINS - CHOC CHIP', 'Muffin'),
  ('STO001', 'PRO082', 'PITA - WHITE LARGE', 'Pita Large Single'),
  ('STO001', 'PRO083', 'PITA - WHITE MINI', 'Pita Mini Single'),
  ('STO001', 'PRO086', 'RUGELACH - CHOCOLATE', 'Ruggelach'),
  ('STO001', 'PRO087', 'RUGELACH - CINNAMON', 'Ruggelach'),
  ('STO001', 'PRO088', 'SCROLLS - CHOCOLATE', 'Scroll'),
  ('STO001', 'PRO089', 'SCROLLS - CINNAMON', 'Scroll'),
  ('STO001', 'PRO090', 'SCROLLS - POPPY', 'Scroll'),
  ('STO001', 'PRO091', 'SLICED BREAD - MULTIGRAIN', 'Sliced Bread'),
  ('STO001', 'PRO092', 'SLICED BREAD - WHITE', 'Sliced Bread'),
  ('STO001', 'PRO093', 'SLICED BREAD - WHOLEMEAL', 'Sliced Bread'),
  ('STO001', 'PRO094', 'SNAILS - CHOC CHIP', 'Snail'),
  ('STO001', 'PRO095', 'SNAILS - SULTANA', 'Snail'),
  ('STO001', 'PRO096', 'SOURDOUGH - RYE', 'Sourdough'),
  ('STO001', 'PRO097', 'SOURDOUGH - SOY AND LINSEED', 'Sourdough'),
  ('STO001', 'PRO098', 'SOURDOUGH - SPELT', 'Sourdough'),
  ('STO001', 'PRO099', 'SOURDOUGH - WHITE', 'Sourdough'),
  ('STO001', 'PRO100', 'SOURDOUGH - WHOLEMEAL', 'Sourdough'),
  ('STO001', 'PRO101', 'STICKS - FRUIT', 'Cake'),
  ('STO001', 'PRO105', 'GLUTEN FREE SEEDED BREAD', ''),
  ('STO001', 'PRO106', 'SOURDOUGH - OLIVE', ''),
  ('STO001', 'PRO107', 'SOURDOUGH - FRUIT & NUT', ''),
  ('STO001', 'PRO108', 'CHALLAH - CHOC CHIP', 'Challah Large'),
  ('STO001', 'PRO109', 'KNOT ROLLS - WHITE', 'Knot Roll'),
  ('STO001', 'PRO110', 'KNOT ROLLS - WHOLEMEAL', 'Knot Roll'),
  ('STO001', 'PRO111', 'PITA - WHOLEMEAL LARGE', 'Pita Large Single'),
  ('STO001', 'PRO112', 'ROLLS - GLUTEN FREE', 'Bread Roll'),
  ('STO001', 'PRO113', 'BAGEL - SESAME X 3', 'Bagel single'),
  ('STO001', 'PRO114', 'BAGEL - BLUEBERRY', 'Bagel single')
)
insert into store_product_prices
       (store_id, product_id, unit_price, xero_code, source, updated_at, updated_by)
select s.id, p.id, 0, nullif(l.xero_code, ''), 'legacy-zero', now(), 'migration-097'
  from legacy l
  join stores   s on s.retailer_store_id  = l.legacy_store
  join products p on p.legacy_product_id  = l.legacy_product
    on conflict (store_id, product_id) do nothing;
