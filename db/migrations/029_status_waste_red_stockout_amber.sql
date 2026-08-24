-- Migration 029: waste drives RED, selling out drives AMBER.
--
-- jb_status was:
--   red:   waste > 30%  OR  >= 3 stockout days
--   amber: waste >= 20% OR  >= 1 stockout day
--
-- The stockout half has never actually run, because on_hand_ledger was empty and
-- every store scored 0. Loading the real 16-22 Aug week switches it on, and
-- measured against that week it puts 92 of the 95 feed-reporting stores into
-- RED -- 2 amber, 1 green. A status where everything is red is not a status.
--
-- The deeper problem is that it points the wrong way. Jesse's network is running
-- 34.3% waste. On a day a store sells out it has, on average, 2.4 of its ~12.9
-- ranged lines empty -- real, but in a business over-supplying by a third,
-- some empty lines are the CORRECT end state, not a fault. Flagging those
-- stores red tells Simona to send more, which is the opposite of what this
-- system exists to do.
--
-- So the two conditions are separated by what they mean:
--   RED   = the money problem. Waste over the limit. Unchanged, 64 stores.
--   AMBER = the service problem. Selling out, or waste creeping up. Visible,
--           without drowning the signal that pays for the project.
--
-- Selling out never reaches red on its own. If a store is BOTH wasting and
-- running dry that is an allocation problem inside the store's range, and the
-- waste condition already catches it.
--
-- Thresholds otherwise untouched: 30% and 20% are Simona's own numbers, and
-- she has said 20-25% waste is where she wants to sit.

create or replace function jb_status(waste_pct numeric, stockout_days int)
returns text language sql immutable as $$
  select case
    when waste_pct > 30                          then 'red'
    when waste_pct >= 20 or stockout_days >= 1   then 'amber'
    else 'green' end
$$;
