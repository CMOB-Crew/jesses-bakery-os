-- Migration 102: the postcodes were in the addresses all along.
--
-- WHAT WAS WRONG
--
-- stores.postcode is null for all 349 stores, and lib/queries.ts:1018 reads
-- it on every store page to build the address. So every address on screen
-- renders without a postcode, for a delivery business, and nothing looks
-- broken -- which is why nobody has mentioned it.
--
-- It is a worse shape than the nine columns nothing touches. This is a field
-- the application asks for every single time and never gets an answer to.
--
-- MEASURED BEFORE ANY OF THIS WAS WRITTEN, on production, 14 September:
--
--   349  stores
--   314  have an address
--   302  end in a four-digit group
--   285  already have lat and lng
--     0  have a postcode
--
-- WHY IT REQUIRES A STATE AND NOT JUST FOUR DIGITS
--
-- The obvious rule is "take the last four digits". The obvious rule would
-- also take the 1234 out of "SHOP 1234, SOME ROAD" and write it into a
-- delivery address as a postcode.
--
-- Every extractable address in this data has the same shape:
--
--   SHOP 9/152-162 CAMPBELL PARADE, BONDI BEACH NSW 2026
--   19 CHARLOTTE ST, ASHFIELD NSW 2131
--
-- A state abbreviation immediately before the digits. Requiring it costs a
-- handful of rows and removes the entire class of mistake, and a missing
-- postcode is a much cheaper thing to be wrong about than a confidently
-- incorrect one on a delivery address.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--
-- The addresses that have a suburb and no postcode are the tempting ones:
--
--   178-184 WILLARONG RD, CARINGBAH
--   443 OLD SOUTH HEAD RD, ROSE BAY
--   227 RAILWAY TERRACE, SCHOFIELDS
--
-- A suburb lookup would fill those. It is not done here, because several
-- Sydney suburb names span more than one postcode and some are shared across
-- states, and a wrong postcode on a delivery address is worse than an empty
-- one. Those stay null and are reported at the end so they can be asked for
-- rather than guessed.
--
-- Nor does it touch lat/lng. 285 stores have them, which means something has
-- already geocoded these addresses once -- and whatever did that had the
-- postcode and dropped it. Worth finding before anyone reaches for a
-- geocoding API; not worth blocking this on.
--
-- NOT IDEMPOTENT, AND DELIBERATELY SO. Running it a second time REFUSES with
-- a message rather than doing nothing quietly.
--
-- The update itself is safe to repeat -- `where postcode is null` sees to
-- that -- but the guard below fires first, because the documented reversal is
-- only exact while every postcode in the table is null. A one-shot backfill
-- that silently no-ops looks identical to one that silently did nothing the
-- first time, and this codebase has been bitten by that shape four times.
--
-- TO BACKFILL STORES ADDED LATER, run the UPDATE statement on its own. The
-- guard exists for this one-time run against a table that is entirely empty
-- of postcodes, not for the statement.
--
-- REVERSIBLE, exactly, because every postcode in this table today is null:
--
--   update stores set postcode = null where postcode is not null;

begin;

-- Belt and braces: if this is somehow run against a database where postcodes
-- already exist, the reversal above stops being exact. Say so and stop,
-- rather than quietly making a mess that cannot be undone cleanly.
do $$
declare existing int;
begin
  select count(postcode) into existing from stores;
  if existing > 0 then
    raise exception
      'stores.postcode already has % non-null values. This migration was written against a table where every one was null, and its documented reversal assumes that. Check before proceeding.', existing;
  end if;
end $$;

update stores
   set postcode = substring(
         address from '(?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)[[:space:]]+([0-9]{4})[[:space:]]*$')
 where postcode is null
   and address ~ '(?:NSW|VIC|QLD|SA|WA|TAS|NT|ACT)[[:space:]]+[0-9]{4}[[:space:]]*$';

-- Nothing outside the Australian range should have got through, and if
-- something did it is better to fail the whole migration than to leave one
-- nonsense postcode behind in 349 good ones.
do $$
declare bad int;
begin
  select count(*) into bad
    from stores
   where postcode is not null
     and (postcode !~ '^[0-9]{4}$' or postcode::int < 200 or postcode::int > 9999);
  if bad > 0 then
    raise exception 'Extracted % postcode(s) outside the Australian range. Nothing has been committed.', bad;
  end if;
end $$;

commit;

-- What landed, and what is still missing and why. Run after committing.
--
--   select
--     count(*)                                                        as stores,
--     count(postcode)                                                 as now_have_one,
--     count(*) filter (where postcode is null
--                        and coalesce(trim(address),'') = '')         as no_address_at_all,
--     count(*) filter (where postcode is null
--                        and coalesce(trim(address),'') <> '')        as address_but_no_postcode
--   from stores;
--
--   select name, address from stores
--    where postcode is null and coalesce(trim(address),'') <> ''
--    order by name;
