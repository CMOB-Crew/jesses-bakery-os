-- 038 — a stockout needs stock to run out of
--
-- WHAT WAS WRONG
--
-- 028 fixed stockout_days to count DAYS rather than store x product x day rows.
-- It kept the test itself:
--
--     closing_on_hand = 0 and expired = 0
--
-- That reads as "the shelf ended empty and nothing was thrown away, so they ran
-- out". It is missing the premise. A product the store does not stock has
-- opening 0, delivered 0, sold 0, expired 0 and closing 0 — it passes the test
-- every single day, forever.
--
-- Woolworths Neutral Bay Village reads "sold out on 7 days". Seven out of seven.
-- Of the 27 zero-closing rows behind that, 14 are lines with nothing delivered
-- and nothing sold: challah semisweet plain and sesame, day after day, at a
-- store that does not range them.
--
-- Measured across the live week (16-22 Aug):
--
--   sellout rows counted         1,664  ->  353     (79% were phantom)
--   stores flagged                 173  ->   84
--   average stockout days / store  4.0  ->   1.3
--   stores red on stockouts alone  138  ->   41
--
-- WHERE IT LEAKS
--
--   * jb_status(waste_pct, stockout_days) — >= 3 days red, >= 1 amber. 138
--     stores were being pushed red by phantom stockouts. Really 41.
--   * Lost sales — (total_sold / 7) * stockout_days * 0.5. With the average
--     falling 4.0 -> 1.3 the headline drops by roughly a factor of three. We
--     have been quoting $31,463/wk.
--   * The store page copy — "sold out on 7 days" with no product and no day was
--     the thing Simona said she had never been able to see. Showing her the
--     wrong seven days is worse than showing her nothing.
--
-- THE FIX
--
--     closing_on_hand = 0 and expired = 0 and (opening_on_hand + delivered) > 0
--
-- Stock was there, none of it expired, it ended at zero. That is running out.
-- The added clause implies sold > 0 by the ledger's own balance, so it needs no
-- separate test.
--
-- This is the same mistake as the waste bug and the on-hand bug, for the third
-- time: A ZERO THAT MEANS "NOTHING WAS THERE" READ AS A ZERO THAT MEANS
-- "IT ALL WENT". Worth naming, because the shape keeps recurring.
--
-- Body below is 028's, verbatim, with only the stk filter changed. Column order
-- and names unchanged, so `create or replace view` is safe.

create or replace view v_store_week as
with a as (select as_of from v_asof),
-- Is this store's sales feed REPORTING, in the same window everything else on
-- this view uses? Not "did it ever report" — that is too loose. The Coles feed
-- stopped on 3 Aug 2026 (report format change). Those stores have two years of
-- history and are still being delivered to, so an "ever" test counts them as
-- reporting and every unit delivered since reads as waste: 64.8% network-wide
-- instead of the real 34.6%.
--
-- We cannot tell "sold nothing" from "feed stopped reporting", and defaulting to
-- 100% waste is the dangerous half of that. So: no sales in the window means
-- waste is unknowable, and the store reads no-data.
feed as (
  select distinct sd.store_id
  from sales_daily sd, a
  where sd.sale_date >  a.as_of - interval '7 days'
    and sd.sale_date <= a.as_of
),
sold as (
  select s.store_id, sum(s.units_sold)::int total_sold
  from sales_daily s, a
  where s.sale_date >  a.as_of - interval '7 days'
    and s.sale_date <= a.as_of
  group by s.store_id
),
sold_prev as (
  select s.store_id, sum(s.units_sold)::int total_sold_prev
  from sales_daily s, a
  where s.sale_date >  a.as_of - interval '14 days'
    and s.sale_date <= a.as_of - interval '7 days'
  group by s.store_id
),
sent as (
  select d.store_id, sum(di.qty_sent)::int total_sent
  from deliveries d
  join delivery_items di on di.delivery_id = d.id, a
  where d.delivery_date >  a.as_of - interval '7 days'
    and d.delivery_date <= a.as_of
  group by d.store_id
),
waste as (
  select w.store_id, sum(w.qty)::int total_wasted
  from wastage w, a
  where w.waste_date >  a.as_of - interval '7 days'
    and w.waste_date <= a.as_of
  group by w.store_id
),
stk as (
  -- A stockout DAY is a calendar day on which at least one line hit zero with
  -- nothing left to expire. If stock was left over to expire, the store did not
  -- run out.
  --
  -- This was count(*), which counts store x product x day ROWS, not days. With
  -- on_hand_ledger empty it always returned 0 so nobody noticed; the moment the
  -- real week loaded it produced a max of 70 "days" in a 7-day week.
  --
  -- It is not a cosmetic label problem. stockout_days feeds
  -- jb_status(waste_pct, stockout_days), where >= 3 is red and >= 1 is amber --
  -- so a row count would have turned nearly every store on the Overview red at
  -- once. It also drives the Lost sales estimate,
  -- (total_sold / 7) * stockout_days * 0.5, which would have overstated lost
  -- units by roughly ten times.
  select l.store_id,
         count(distinct l.as_of_date)
           filter (where l.closing_on_hand = 0
                     and l.expired = 0
                     -- ...AND there was stock there to run out of. See 038.
                     and (l.opening_on_hand + l.delivered) > 0)::int stockout_days
  from on_hand_ledger l, a
  where l.as_of_date >  a.as_of - interval '7 days'
    and l.as_of_date <= a.as_of
  group by l.store_id
)
select
  st.id                                        as store_id,
  st.name,
  st.retailer,
  st.size_category,
  st.shelf_max,
  st.region_id,
  reg.name                                     as region,
  coalesce(sent.total_sent, 0)                 as total_sent,
  coalesce(sold.total_sold, 0)                 as total_sold,
  coalesce(sold_prev.total_sold_prev, 0)       as total_sold_prev,
  case when f.store_id is null then null else coalesce(
    waste.total_wasted,
    greatest(coalesce(sent.total_sent,0) - coalesce(sold.total_sold,0), 0)
  ) end                                        as total_wasted,
  coalesce(stk.stockout_days, 0)               as stockout_days,
  case when f.store_id is null then null else round(
    100.0 * coalesce(
      waste.total_wasted,
      greatest(coalesce(sent.total_sent,0) - coalesce(sold.total_sold,0), 0)
    ) / nullif(coalesce(sent.total_sent,0), 0)
  , 1) end                                     as waste_pct,
  case when f.store_id is null then 'green' else jb_status(
    round(
      100.0 * coalesce(
        waste.total_wasted,
        greatest(coalesce(sent.total_sent,0) - coalesce(sold.total_sold,0), 0)
      ) / nullif(coalesce(sent.total_sent,0), 0)
    , 1),
    coalesce(stk.stockout_days, 0)
  ) end                                        as status,
  -- Appended last on purpose: `create or replace view` can only ADD columns at
  -- the end, never insert one mid-list.
  (f.store_id is not null)                     as has_sales_feed
from stores st
left join regions reg on reg.id = st.region_id
left join sold      on sold.store_id      = st.id
left join sold_prev on sold_prev.store_id = st.id
left join sent      on sent.store_id      = st.id
left join waste     on waste.store_id     = st.id
left join stk       on stk.store_id       = st.id
left join feed      f  on f.store_id        = st.id
where st.active;


-- Verify:
--   select round(avg(stockout_days),2) as avg_days,
--          count(*) filter (where stockout_days >= 3) as red_on_stockouts,
--          count(*) filter (where stockout_days > 0)  as any_stockout
--     from v_store_week where has_sales_feed;
--
-- Expect roughly: avg 1.3, red 41, any 84.
-- Then reload the Overview, Stores and Lost sales — all three read this view.
