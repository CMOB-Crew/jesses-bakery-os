-- Migration 024: unit of measure per product, from Jesse's own Products_Master
--
-- Source: the legacy Azure export Fred delivered 24 Aug 2026
-- (legacy-dump/tables/Products_Master.csv), columns BakingUOM + BakingQuantity.
--
-- Supersedes the app_settings.tray_sizes approach added earlier the same day.
-- That modelled tray size as ONE number per category (bagels, challah), which is
-- wrong: Jesse bakes mini bagels 40 to a tray and regular bagels 24, so a single
-- "bagels" number cannot be right for both. UoM belongs to the product, not the
-- category, and Jesse's own system has always held it that way.
--
-- 21 of 116 products are baked and counted by the tray (all bagels + mini
-- challah); the other 95 are counted by the individual unit. Everything not
-- listed below stays 'UNIT', which is the default -- so a product we don't know
-- about behaves exactly as it does today rather than guessing a tray size.
--
-- Idempotent: guarded add + upsert-style updates. Safe to run more than once.

alter table products add column if not exists baking_uom text not null default 'UNIT';
alter table products add column if not exists baking_qty int;

alter table products drop constraint if exists products_baking_uom_chk;
alter table products add constraint products_baking_uom_chk
  check (baking_uom in ('UNIT','TRAY'));

-- Units per tray, exactly as Jesse's Products_Master holds them.
update products p
   set baking_uom = 'TRAY',
       baking_qty = v.qty
  from (values
    ('PRO008',40),  -- BAGEL - MINI
    ('PRO009',40),  -- BAGEL - MINI (X 6)
    ('PRO010',24),  -- BAGEL - MIXED SEEDS
    ('PRO011',24),  -- BAGEL - MIXED SEEDS (X 5)
    ('PRO012',24),  -- BAGEL - PLAIN
    ('PRO013',24),  -- BAGEL - PLAIN (X 3)
    ('PRO014',24),  -- BAGEL - PLAIN (X 5)
    ('PRO015',24),  -- BAGEL - POPPY SEED
    ('PRO016',24),  -- BAGEL - POPPY SEED (X 5)
    ('PRO017',24),  -- BAGEL - RAISIN
    ('PRO018',24),  -- BAGEL - SESAME
    ('PRO019',24),  -- BAGEL - SESAME (X 5)
    ('PRO020',24),  -- BAGEL - WHOLEMEAL
    ('PRO021',24),  -- BAGEL - WHOLEMEAL (X 5)
    ('PRO022',24),  -- BAGEL - ZATAR
    ('PRO074',20),  -- MINI CHALLAH - PLAIN
    ('PRO075',20),  -- MINI CHALLAH - PLAIN (X 4)
    ('PRO077',20),  -- MINI CHALLAH - SESAME
    ('PRO078',20),  -- MINI CHALLAH - SESAME (X 4)
    ('PRO113',24),  -- BAGEL - SESAME (X 3)
    ('PRO114',24)   -- BAGEL - BLUEBERRY
  ) as v(product_id, qty)
 where p.id = v.product_id;

comment on column products.baking_uom is
  'How the floor counts this line when baking: UNIT or TRAY. From Jesse''s Products_Master (BakingUOM). Bagels and mini challah go by the tray; everything else by the individual unit.';
comment on column products.baking_qty is
  'Units per tray, when baking_uom = TRAY. Null for UNIT lines. From Jesse''s Products_Master (BakingQuantity) -- bagels 24, mini bagels 40, mini challah 20.';
