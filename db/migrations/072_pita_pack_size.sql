-- Large white pita is a four-pack. Measured, not asked.
--
-- Simona said so at 43:23 on 1 Sept and appeared to contradict it at 1:25:17
-- ("Pitta Mini Single, Pitta Large Single, because they're not on trays").
-- She did not: the second sentence gives its own reason and it is about how
-- pita is COUNTED on the production sheet, not how it is sold.
--
-- The retailers describe everything by weight, and the loaded feed files still
-- carry their text even though feed_staging is transient and empty:
--
--   Jesse's Boiled Bagels 550g        known 5-pack    110g each
--   Jesse's Mini Challah Rolls 400g   known 4-pack    100g each
--   Jesse's Challah Dairy Free 600g   a loaf          600g
--   Jesse's Pita Bread 400g           400 / 4      =  100g each
--
-- 400g over four is exactly the confirmed mini-challah-roll unit weight, and a
-- single 400g pita does not exist. Weight arithmetic and what she said agree,
-- which is the bar the bagel packs had to clear too.
--
-- PITA - WHITE MINI is deliberately left at 1. She said six, but it is
-- invoice-only with no supermarket volume, so there is no weight and no price
-- to check it against. Guessing it would be the one unmeasured number in a
-- change whose whole point is that nothing is guessed.

update products
   set pack_size = 4
 where name = 'PITA - WHITE LARGE'
   and pack_size = 1;
