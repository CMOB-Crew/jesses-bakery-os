-- Migration 073: what each customer pays for each product.
--
-- WHY THIS IS PER STORE AND NOT A TIER TABLE.
--
-- 001 shipped pricing_tiers + product_prices as empty shells, and a tiered
-- pricing model was drafted on top of them. The legacy price list says that is
-- the wrong shape. Measured 3 September against StandingOrderPriceList (1,911
-- rows, 59 stores, 96 products, 649 real prices):
--
--   * Price does not track order size. Correlation between price and weekly
--     standing-order quantity is +0.03 for SOURDOUGH - WHITE across 16
--     customers and -0.18 for CHALLAH - SEMISWEET PLAIN across 15. Volume tiers
--     would predict a strong negative in both.
--   * Price tracks the ACCOUNT. Every C&M branch pays the same on all 16 of its
--     products; Jack & Co on all 22; BP on all 18; Mount Sinai on all 14 --
--     regardless of how big the branch is.
--   * The direction is often the opposite of a volume discount. BP service
--     stations pay the most for sourdough (5.75); schools pay the least for
--     challah (4.25); the highest challah price sits at a preschool and a
--     synagogue (5.50).
--
-- Which matches Simona on 1 Sept: "a price column, per customer, overridable".
--
-- pricing_tiers and product_prices are LEFT ALONE, not dropped. They are empty
-- and harmless, stores.pricing_tier_id still references the tier table, and a
-- baseline list price is a sensible thing to keep there later. This adds the
-- layer that is actually needed rather than rebuilding what is already there.
--
-- WHY xero_code LIVES HERE AND NOT ON products.
--
-- Because the same product genuinely bills as different Xero items for
-- different customers. PITA - WHITE LARGE maps to "Pita Large 4 Pack" for some
-- stores and "Pita Large Single" for others -- which is why the answer to
-- "is large white pita a 4-pack or a single" is "both, depending on the
-- customer". A single code on the product row cannot express that, and forcing
-- one would silently bill somebody for the wrong thing.
--
-- Additive and idempotent.

create table if not exists store_product_prices (
  store_id    uuid not null references stores(id)   on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  unit_price  numeric(10,2) not null check (unit_price >= 0),
  -- The Xero item this line bills as, for THIS customer. Null means not yet
  -- mapped, which must block the invoice rather than guess.
  xero_code   text,
  -- 'legacy' = came across in the migration from the old price list.
  -- 'manual'  = set by someone in the app since. Lets a re-run of the import
  -- leave hand-corrections alone instead of stamping over them.
  source      text not null default 'manual' check (source in ('legacy','manual')),
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (store_id, product_id)
);

create index if not exists store_product_prices_product_idx
  on store_product_prices (product_id);

comment on table store_product_prices is
  'What one customer pays for one product, and the Xero item it bills as. Per store, not per tier: measured against 649 real price points, price tracks the account and not the order size. xero_code is per store because the same product bills as different Xero items for different customers (large white pita is a 4-pack for some and a single for others).';

comment on column store_product_prices.xero_code is
  'The Xero item code for this customer and product. Null = not mapped yet; an invoice must refuse rather than guess, because a wrong code bills silently.';

-- RLS, matching 018's write-back tables.
alter table store_product_prices enable row level security;
alter table store_product_prices force  row level security;

drop policy if exists biz_all on store_product_prices;
create policy biz_all on store_product_prices
  for all
  using      (public.current_app_role() in ('admin','manager','office'))
  with check (public.current_app_role() in ('admin','manager','office'));

-- Verify:
--   select count(*) filter (where unit_price > 0) as priced,
--          count(*) filter (where xero_code is null) as unmapped,
--          count(distinct store_id) as stores
--     from store_product_prices;
