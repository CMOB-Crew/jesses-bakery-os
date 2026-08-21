-- Load store state from the 21 Aug Stores Master. Every store is NSW or ACT today
-- (QLD stores aren't loaded yet). So: default all to NSW, then flip the 16 ACT
-- stores by their scan code. Idempotent. QLD stores arrive with their own state
-- set when Somnath's list lands — this doesn't touch them.

update stores set state = 'NSW' where state is null;

update stores set state = 'ACT' where retailer_store_id in (
  'STO120','STO123','STO127','STO276','STO129','STO133','STO139','STO140',
  'STO141','STO148','STO160','STO163','STO167','STO260','STO203','STO210'
);

-- Verify
select state, count(*) from stores where active group by state order by 1;
