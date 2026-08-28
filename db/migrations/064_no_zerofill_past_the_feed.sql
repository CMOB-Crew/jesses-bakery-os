-- =====================================================================
-- Migration 064: the engine stops counting days no retailer reported.
--
-- ---------------------------------------------------------------------
-- MEASURED, NOT SUSPECTED
-- ---------------------------------------------------------------------
-- The plan for go-live day is 20.1% short, and four days later it is half.
--
--     target          zero-filled   reported-only   understated
--     Thu  3 Sep          1,397         1,678          20.1%   <- GO-LIVE
--     Fri  4 Sep          1,717         2,061          20.0%
--     Sat  5 Sep          2,064         2,480          20.1%
--     Sun  6 Sep          1,556         2,302          47.9%
--     Mon  7 Sep          1,105         1,665          50.7%
--     Tue  8 Sep            990         1,489          50.4%
--     Wed  9 Sep            981         1,471          50.0%
--
-- ---------------------------------------------------------------------
-- WHY
-- ---------------------------------------------------------------------
-- jb_plan_day builds each baseline from the six preceding same-weekdays:
--
--     cal  as (select (target_date - 7*n) from generate_series(1,6) g(n))
--     grid as (... pairs cross join cal
--                left join sales_daily -> coalesce(units_sold, 0))
--
-- cal counts back from the TARGET and nothing bounds it to as_of. The last
-- day any feed covered is 2026-08-23, and that day is itself only 7 Harris
-- Farm stores. Every date from 24 Aug to 2 Sep has ZERO stores reporting.
--
-- So a target more than a week past the feed reaches back into dates that do
-- not exist in the data, and coalesce turns each one into a hard zero:
--
--     Thu  3 Sep reaches 27 Aug   0 stores reporting -> counted as a zero
--     Sun  6 Sep reaches 30 + 23 Aug                 -> TWO of its six
--
-- One dead observation in six is -16.7%. Two is -33%. That is exactly the
-- 20% and 50% measured above, and it compounds every week the feeds stay dark.
--
-- ---------------------------------------------------------------------
-- THE ZERO-FILL ITSELF IS NOT THE MISTAKE
-- ---------------------------------------------------------------------
-- 037 added it deliberately and the reasoning was right:
--
--     "sales_daily only holds rows for days something SOLD -- the retailers
--      report sales, not zeros. Taking the last 6 rows therefore averaged over
--      only the days that HAD a sale and silently dropped every zero day.
--      Across live stores the mean came out 1.49x true demand."
--
-- That holds INSIDE a feed's reporting window. A store that filed a report
-- and simply had no sale of one line genuinely sold zero of it.
--
-- Past the window's last date it inverts. A store that filed nothing at all
-- has an UNKNOWN day, not a zero day, and averaging the unknown in as zero
-- drags the mean down by exactly 1/6 per missing day.
--
-- Null is not zero. Same trap as coalesce(recommended, 0) in the delivery
-- plan, and as the no-feed stores in the waste denominator, and as median()
-- over stores with no feed reading 0.0% waste on the Overview.
--
-- ---------------------------------------------------------------------
-- THE RULE THIS USES INSTEAD
-- ---------------------------------------------------------------------
-- Count a (store, day) cell only if that store filed SOMETHING that day.
--
--   store reported that day, no row for this product  -> a real zero, counted
--   store reported nothing that day                   -> unknown, excluded
--
-- It needs no as_of bound and no knowledge of which retailer is dark. It is
-- self-correcting: when Simona sends the Coles files, those days become
-- reported and re-enter every baseline on the next run with no code change.
--
-- ---------------------------------------------------------------------
-- WHAT IT COSTS — measured before writing it
-- ---------------------------------------------------------------------
-- Of 1,205 store-product pairs planned for 3 Sept:
--
--     1,195 keep 5 of 6 observations
--         9 keep 4 of 6
--         1 keeps NONE and drops out of the plan entirely
--
-- That one pair is a store-product with no sale on any of the six preceding
-- same-weekdays. It is named in the report below. Dropping it is correct: it
-- has no baseline, and inventing one from zeros is the fault being fixed.
--
-- n falls from 6 to 5 for almost everything, so stddev_pop still has real
-- observations and the `n <= 1 -> std = mean * 0.25` fallback stays unused.
--
-- ---------------------------------------------------------------------
-- HOW IT IS APPLIED
-- ---------------------------------------------------------------------
-- Self-patch through pg_get_functiondef, the same method as 057 and 062: read
-- the live definition, substitute one clause, re-execute. Three guards -- the
-- function exists, it is not already patched, and the anchor appears exactly
-- once. The full pre-patch definition is snapshotted to jb_fn_backup_064
-- first, so the undo is exact rather than reconstructed.
--
-- ALSO HERE: two stores with a null size_category, found in the same sweep.
-- Both already carry shelf ranges that name their band unambiguously, so this
-- is filling in a blank, not making a judgement.
--
-- NOTHING ELSE CHANGES. No event, rate, window, store list or product list.
-- Idempotent.
-- =====================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------
-- 1. Snapshot the live definition so the undo is byte-exact.
-- ---------------------------------------------------------------------
create table if not exists jb_fn_backup_064 (
  fn          text primary key,
  definition  text not null,
  snapped_at  timestamptz not null default now()
);
alter table jb_fn_backup_064 enable row level security;
alter table jb_fn_backup_064 force  row level security;
drop policy if exists biz_all on jb_fn_backup_064;
create policy biz_all on jb_fn_backup_064 for all
  using      (public.current_app_role() in ('admin','manager','office'))
  with check (public.current_app_role() in ('admin','manager','office'));

insert into jb_fn_backup_064 (fn, definition)
select 'jb_plan_day', pg_get_functiondef(p.oid)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where p.proname = 'jb_plan_day' and n.nspname = 'public'
on conflict (fn) do nothing;

\echo ''
\echo '=== snapshot taken (0 rows inserted = it was already there) ==='
select fn, length(definition) as chars, snapped_at from jb_fn_backup_064;

-- ---------------------------------------------------------------------
-- 2. Patch.
-- ---------------------------------------------------------------------
do $patch$
declare
  src      text;
  needle   constant text :=
E'     and sd.sale_date  = cal.d\n  ),';
  addition constant text :=
E'     and sd.sale_date  = cal.d\n'
'    -- 064: only count a day this store actually FILED.\n'
'    --\n'
'    -- Without this, cal reaches past the end of the feed and coalesce turns\n'
'    -- every unreported date into a hard zero. Measured on 2026-08-28 with\n'
'    -- the feed ending 23 Aug: the plan for go-live day ran 20.1% short and\n'
'    -- for the Sunday after it 47.9% short, because one and then two of the\n'
'    -- six observations were dates on which no store in the network filed\n'
'    -- anything at all.\n'
'    --\n'
'    -- The zero-fill above is still right INSIDE the reporting window: a\n'
'    -- store that filed a report and had no sale of a line genuinely sold\n'
'    -- zero. This only removes the cells where the store filed NOTHING, which\n'
'    -- are unknown rather than zero.\n'
'    --\n'
'    -- Self-correcting: when the Coles files land, those dates become\n'
'    -- reported and re-enter every baseline on the next run, no code change.\n'
'    where exists (\n'
'      select 1 from sales_daily rp\n'
'       where rp.store_id  = pr.store_id\n'
'         and rp.sale_date = cal.d\n'
'    )\n'
'  ),';
  n_anchor int;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'jb_plan_day' and n.nspname = 'public';

  if src is null then
    raise exception '064: jb_plan_day does not exist. Nothing patched.';
  end if;

  if position('064: only count a day this store actually FILED' in src) > 0 then
    raise notice '064: already applied, leaving it alone.';
    return;
  end if;

  n_anchor := (length(src) - length(replace(src, needle, ''))) / length(needle);
  if n_anchor <> 1 then
    raise exception '064: anchor found % times, expected exactly 1. Nothing patched. The live function is not in the state this migration was written against.', n_anchor;
  end if;

  execute replace(src, needle, addition);
  raise notice '064: jb_plan_day patched.';
end
$patch$;

\echo ''
\echo '=== 1. IS THE PATCH LIVE? ==='
select case when pg_get_functiondef(p.oid) like '%064: only count a day this store actually FILED%'
            then 'YES - engine no longer zero-fills unreported days'
            else 'NO  - PATCH DID NOT APPLY, STOP' end as patched
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where p.proname = 'jb_plan_day' and n.nspname = 'public';

\echo ''
\echo '=== 2. THE DATES THAT WERE BEING COUNTED AS ZEROS ==='
\echo '    Any date here with 0 stores was contributing a fabricated zero to'
\echo '    every target that reaches back to it. It now contributes nothing.'
select d::date                                as cal_day,
       to_char(d, 'Dy')                       as dow,
       coalesce(r.stores, 0)                  as stores_reporting
  from generate_series(date '2026-08-16', date '2026-09-02', interval '1 day') d
  left join (select sale_date, count(distinct store_id) as stores
               from sales_daily group by 1) r on r.sale_date = d::date
 order by 1;

\echo ''
\echo '=== 3. THE ONE PAIR THAT LOSES ITS BASELINE — named, not just counted ==='
with a as (select coalesce(max(sale_date), current_date) as d from sales_daily),
live as (select distinct sd.store_id from sales_daily sd, a
          where sd.sale_date > a.d - 7 and sd.sale_date <= a.d),
pairs as (
  select distinct sd.store_id, sd.product_id
    from sales_daily sd, a
   where sd.sale_date > a.d - 42 and sd.sale_date <= a.d
     and sd.store_id in (select store_id from live)
),
cal as (select (date '2026-09-03' - 7 * g.n)::date as d from generate_series(1,6) g(n))
select s.name as store, p.name as product,
       'no sale on any of the six preceding Thursdays' as why_it_drops
  from pairs pr
  join stores s   on s.id = pr.store_id
  join products p on p.id = pr.product_id
 where not exists (
   select 1 from cal c
    where exists (select 1 from sales_daily rp
                   where rp.store_id = pr.store_id and rp.sale_date = c.d))
 order by 1,2;

-- ---------------------------------------------------------------------
-- 3. The two unsized stores, from the same sweep.
--    Both already carry a shelf range that names the band on its own:
--      WOOLWORTHS METRO ROSE BAY   82-140  -> the page's Large band is 82-140
--      COLES LISAROW               50- 60  -> the page's Small band is 50-60
--    They were invisible in Waste-by-store-size, which is why its All-sizes
--    tile read 205 and its three bands summed to 203.
-- ---------------------------------------------------------------------
update stores set size_category = 'large'
 where name = 'WOOLWORTHS METRO ROSE BAY' and size_category is null
   and shelf_min = 82 and shelf_max = 140;

update stores set size_category = 'small'
 where name = 'COLES LISAROW' and size_category is null
   and shelf_min = 50 and shelf_max = 60;

\echo ''
\echo '=== 4. UNSIZED RETAIL STORES REMAINING — ZERO rows expected ==='
select s.name, s.retailer::text as retailer, s.shelf_min, s.shelf_max
  from stores s
 where s.active and s.retailer::text <> 'invoice'
   and (s.size_category is null
        or lower(s.size_category::text) not in ('small','medium','large','xlarge'))
 order by 1;

\echo ''
\echo '=== 5. SIZE BANDS NOW — the three should sum to the retail total ==='
select coalesce(s.size_category::text, 'NULL') as size_category,
       count(*) filter (where s.retailer::text <> 'invoice') as retail_stores
  from stores s where s.active
 group by 1 order by 2 desc;

-- Undo:
--   do $$ declare d text; begin
--     select definition into d from jb_fn_backup_064 where fn = 'jb_plan_day';
--     execute d;
--   end $$;
--   update stores set size_category = null
--    where name in ('WOOLWORTHS METRO ROSE BAY','COLES LISAROW');
--   -- then replan: call jb_run_engine(7, null, 'manual');
