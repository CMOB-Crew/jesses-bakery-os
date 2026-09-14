-- ---------------------------------------------------------------------------
-- 104  KORMEHL EMANUEL PRESCHOOL CANNOT BE INVOICED, AND 097 SAID THIS
--      MIGRATION WOULD COME.
--
-- Migration 097 loaded Jesse's Cafe's zero prices and deliberately left this
-- customer alone. Its own words:
--
--     It does not touch KORMEHL EMANUEL PRESCHOOL, which is the other
--     customer refusing for a real reason (2 ordered lines, no price, 31 zero
--     rows in the legacy list). @Fred said the $0 lines are concentrated in
--     TWO stores and named only Jesse's Cafe. Kormehl is the obvious
--     candidate and it is NOT CONFIRMED, and billing a preschool $0 on a
--     guess is not a thing to do quietly. Asked on 14 September; it gets its
--     own migration when the answer lands.
--
-- This is that migration. The answer did not come from asking again. It was
-- already in legacy-load/, and nobody had looked.
--
-- WHAT THE LEGACY ORDER BOOK ACTUALLY SAYS
--
-- 074b_standing_orders_load.sql, STO034, the only day with anything on it:
--
--     CHALLAH - GLUTEN FREE        fri   1
--     100GR CHALLAH DOUGH BALLS    fri  60
--     CHALLAH - RYE                fri   1
--     CHALLAH - SEMISWEET PLAIN    fri  24
--
-- 073b_price_load.sql carries three prices for this customer and no more:
-- BAGEL - BLUEBERRY 1.50, DOUGH BALLS 0.90, SEMISWEET PLAIN 4.25. So of the
-- four lines delivered on a Friday, two are priced and two are not.
--
--     60 x 0.90  =   54.00
--     24 x 4.25  =  102.00
--                  -------
--                   156.00
--
-- @Fred's invoice file for the 6 September run bills this customer $156.00.
-- The two unpriced lines therefore contribute nothing, which is what a zero
-- line does.
--
-- AND THE ZERO LINES ARE ON THE INVOICE RATHER THAN ABSENT FROM IT
--
-- @Fred, 11 September, on the same file: "244 of the 725 lines are $0". If
-- production dropped zero-priced lines there would not be 244 of them. So
-- production sends them at 0.00, and so should we.
--
-- WHY IT MATTERS THAT WE SEND THEM AT ALL
--
-- buildDayInvoice() refuses a line whose unit_price is NULL, and one refusal
-- stops the whole customer for the whole week. So today Kormehl bills
-- NOTHING, not $156.00. It is one of only two customers out of fifty that
-- refuses for a reason other than "they order nothing", and it is why it
-- shows up in the gap against production.
--
-- THE ONE THING HERE THAT IS INHERITED RATHER THAN MEASURED
--
-- The Xero item code. PRO031 (CHALLAH - GLUTEN FREE) bills as 'Challah Large'
-- for KRINSKYS and for ST IVES GREENGROCER, both in the legacy price list, so
-- that one is confirmed. PRO034 (CHALLAH - RYE) HAS NO PRICED ROW ANYWHERE in
-- that list; 'Challah Large' comes from migration 097, which assigned it for
-- Jesse's Cafe and is already live. It is consistent and it is not
-- independently confirmed. If a rye challah turns out to bill as its own Xero
-- item, this row and 097's are both wrong together, and the invoice would be
-- rejected loudly on that line rather than silently mispriced.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
--   * It does not touch the other 1,168 zero lines. The rule from
--     build_price_load.py still holds everywhere else: a zero for a customer
--     who should be paying is a MISSING price, and billing them $0 would be
--     worse than refusing.
--   * It does not price them. Zero is the price, on the evidence above.
--   * It does not overwrite anything. ON CONFLICT DO NOTHING, so a real price
--     somebody has set since beats an imported zero.
--
-- Idempotent, and reversible in one line:
--
--     delete from store_product_prices
--      where source = 'legacy-zero'
--        and store_id = (select id from stores where retailer_store_id = 'STO034');
-- ---------------------------------------------------------------------------

with legacy(legacy_store, legacy_product, product_name, xero_code) as (
  values
  ('STO034', 'PRO031', 'CHALLAH - GLUTEN FREE', 'Challah Large'),
  ('STO034', 'PRO034', 'CHALLAH - RYE',         'Challah Large')
)
insert into store_product_prices
       (store_id, product_id, unit_price, xero_code, source, updated_at, updated_by)
select s.id, p.id, 0, l.xero_code, 'legacy-zero', now(), 'migration-104'
  from legacy l
  join stores   s on s.retailer_store_id  = l.legacy_store
  join products p on p.legacy_product_id  = l.legacy_product
    on conflict (store_id, product_id) do nothing;

comment on column store_product_prices.source is
  'legacy = came across in the 073b import of the old price list. manual = set by someone in the app since. legacy-zero = a price of 0.00 in the legacy list that is DELIBERATE rather than missing. Loaded by migration 097 for JESSE''S CAFE and by 104 for KORMEHL EMANUEL PRESCHOOL, in both cases on the evidence of a real legacy invoice. Everywhere else a zero is still treated as no price and the invoice refuses.';
