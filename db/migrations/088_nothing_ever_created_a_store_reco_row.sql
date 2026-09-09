-- =====================================================================
-- 088  Nothing ever created a store_reco row
--
-- THE BUG
--
-- jb_rebuild_store_reco() is an UPDATE. It folds a window of
-- replenishment_plans into store_reco.recommended -- for rows that
-- already exist. Nothing anywhere in the codebase INSERTs into
-- store_reco. The only INSERT that has ever run against it is
-- legacy-load/12_golive_write.sql, a one-off script that is not in this
-- repository and will never run again.
--
-- So every (store, product) the engine plans that has no store_reco row
-- is computed, folded into nothing, and discarded. Silently. The store
-- wizard accepts the store, marks it active, takes its run and its
-- delivery days, shows it on the Stores list -- and it never reaches a
-- packing sheet, a delivery sheet or the production board, because all
-- three read store_reco.
--
-- This has already happened. Four of Simona's stores from 3 September
-- were affected; Westmead and Wilton Plaza were selling roughly 107
-- units a week and receiving nothing. It is about to happen again to
-- thirteen Woolworths Metro stores.
--
-- The evidence, from engine_runs: reco_rows sat frozen at 2,865 across
-- five consecutive nightly runs while plan_rows grew 9,154 -> 9,224. The
-- engine's opinion was growing. The table it writes into was not.
--
-- ---------------------------------------------------------------------
-- WHAT THIS DOES, AND THE ONE THING IT DELIBERATELY DOES NOT
--
-- It inserts a row for exactly the pairs the engine HAS PLANNED in this
-- window and which have no row yet. Nothing else.
--
-- It does NOT create a row for every ranged line at every store. That
-- was the obvious version and it is wrong: store_reco currently holds
-- 2,865 rows across 266 stores, roughly eleven lines each, while a store
-- like KRINSKYS is ranged across 38. Inserting every ranged line would
-- multiply the table several times over and put thousands of new zero
-- lines onto the delivery and production sheets the floor is reading
-- today. The bug is that planned lines have nowhere to land, so the fix
-- is to give planned lines somewhere to land.
--
-- A brand-new store with no sales history still gets nothing from this,
-- and that is correct -- the engine has no opinion to record. That case
-- is already handled by Simona's starter bundle, loaded as a 21-day
-- store_product_overrides row (her 14 August email). This migration is
-- what makes the store work from the moment it does have history.
--
-- ---------------------------------------------------------------------
-- SAFETY
--
-- * Inactive stores are excluded. An inactive store gets no rows.
-- * on conflict do nothing, so re-running changes nothing.
-- * sent and sold default to 0, which is honest: nothing has been sent
--   to a line that did not exist a moment ago. It also means rail 1 and
--   rail 2 below cannot misfire on a new row -- both require sent > 0 or
--   sold > 0, and the "no plan, leave it alone" branch cannot be reached
--   because we only insert where a plan exists.
-- * The insert happens after _plan_wk is built and before the update, so
--   the new rows are filled in by the same call rather than waiting a
--   night.
--
-- BEFORE APPLYING, size it. This is the dry run, and it writes nothing:
--
--     select count(*) as rows_that_would_be_created
--       from (select rp.store_id, rp.product_id
--               from replenishment_plans rp
--              where rp.target_date between jb_asof() - 6 and jb_asof()
--              group by 1,2) pw
--       join stores s on s.id = pw.store_id and s.active
--      where not exists (select 1 from store_reco r
--                         where r.store_id = pw.store_id
--                           and r.product_id = pw.product_id);
--
-- Read that number before running the rest. It is how many lines the
-- engine has been computing and throwing away.
-- =====================================================================

create or replace function jb_rebuild_store_reco(p_from date, p_to date)
returns int
language plpgsql
as $fn$
declare
  n int;
  n_new int;
begin
  drop table if exists _plan_wk;
  create temp table _plan_wk as
  select rp.store_id, rp.product_id, sum(rp.recommended_qty)::int as reco_wk
  from replenishment_plans rp
  where rp.target_date between p_from and p_to
  group by 1, 2;

  -- 088: give a planned line somewhere to land.
  --
  -- Without this the whole function is an UPDATE against rows that only
  -- the one-off legacy load ever created, so any store or line added
  -- afterwards is planned and then discarded without a word.
  insert into store_reco (store_id, product_id, sold, sent, recommended)
  select pw.store_id, pw.product_id, 0, 0, 0
    from _plan_wk pw
    join stores s on s.id = pw.store_id
   where s.active
  on conflict (store_id, product_id) do nothing;

  get diagnostics n_new = row_count;
  if n_new > 0 then
    raise notice 'jb_rebuild_store_reco: created % store_reco row(s) that did not exist', n_new;
  end if;

  update store_reco r
  set recommended = f.final_reco
  from (
    select r2.store_id,
           r2.product_id,
           case
             when pw.reco_wk is null then r2.sent                    -- no plan: leave it alone
             when r2.sent > 0 and r2.sold >= r2.sent * 0.95
                  then greatest(pw.reco_wk, r2.sold)                 -- RAIL 1
             when r2.sold > 0 and pw.reco_wk = 0
                  then greatest(1, coalesce(p.min_on_shelf, 1))      -- RAIL 2
             else pw.reco_wk
           end as final_reco
    from store_reco r2
    join products p on p.id = r2.product_id
    left join _plan_wk pw on pw.store_id = r2.store_id and pw.product_id = r2.product_id
  ) f
  where f.store_id = r.store_id and f.product_id = r.product_id;

  get diagnostics n = row_count;
  drop table if exists _plan_wk;
  return n;
end
$fn$;

comment on function jb_rebuild_store_reco(date, date) is
  'Folds a window of replenishment_plans into store_reco.recommended, applying the sold-out floor (rail 1) and the never-delist floor (rail 2). Stores with no plan keep their standing order. Since 088 it also CREATES the row for any planned (store, product) at an active store that has none -- before that this function was an UPDATE only, and every line the engine planned for a store added after the legacy load was computed and silently discarded.';
