-- =====================================================================
-- Migration 081: the per-store service level dial reaches the engine.
--
-- ---------------------------------------------------------------------
-- WHAT THE SCREEN PROMISES
-- ---------------------------------------------------------------------
-- Store profile, under "Service level - this store":
--
--     "Sets the waste-vs-selling-out trade-off for every product here --
--      not just loaves. The plan re-sizes each line to match."
--
-- and at the foot of the same page:
--
--     "This profile is the single source of truth -- ranging, service level
--      and adjustments set here shape the plan."
--
-- and on Settings, under the network dial:
--
--     "Pick this store's level on its profile -- overrides the network
--      default."
--
-- Three separate promises, on the two screens Simona uses most.
--
-- ---------------------------------------------------------------------
-- WHAT ACTUALLY HAPPENED
-- ---------------------------------------------------------------------
-- Nothing. The plan re-sized no line.
--
-- store/actions.ts writes store_settings.service_level. queries.ts reads it
-- back with getStoreServiceLevel, and the ONLY consumer of that read is the
-- store profile page rendering the dial in its saved position. Grepped across
-- SQL, TypeScript and Python: no other reader exists.
--
-- The engine's signature is the proof:
--
--     create or replace function jb_plan_day(p_target date, p_z numeric)
--
-- One z, passed in by jb_run_engine from app_settings.service_level, cross
-- joined into every row through the p2 CTE:
--
--     p2 as (select ..., p_z as z from params)
--     calc as (select ..., c.shelf_max, c.min_on_shelf, p2.z from combos c ...)
--     final as (... + z * (std * sqrt(coverage)) ...)
--
-- There is no per-store branch anywhere in it. Setting a store to Lean saved
-- a row, showed a green "saved" toast, moved the dial, survived a reload, and
-- changed not one loaf.
--
-- Same shape as the four dead levers on Settings (migration-free, shipped as
-- fa11054 earlier today), but worse in one way: those were network defaults
-- Simona would set once. This is the dial she reaches for when ONE shop is
-- throwing bread out, which is the moment the system most needs to listen.
--
-- ---------------------------------------------------------------------
-- THE FIX, AND WHY IT IS THIS SMALL
-- ---------------------------------------------------------------------
-- The mapping already exists and the vocabularies already match:
--
--     store_settings.service_level  check in ('lean','balanced','service')
--     engine_service_levels.scenario         'lean','balanced','service'
--                            .z               0.18,  0.28,      0.39
--
-- 033 built that table to turn the SETTINGS dial into a z. The per-store dial
-- speaks the identical three words. Nobody joined them.
--
-- So: in calc, take this store's z when it has one, otherwise the network z
-- the run was called with.
--
--     coalesce(esl.z, p2.z) as z
--
-- LEFT joins, so a store with no store_settings row -- which is nearly all of
-- them -- is bit-for-bit unchanged. A store whose row has service_level null
-- is likewise unchanged: the join to engine_service_levels finds nothing and
-- the coalesce falls through. The ONLY rows that move are stores where Simona
-- has explicitly chosen a level, which is exactly what she was promised.
--
-- No fan-out: store_settings is one row per store (store_id is its primary
-- key) and engine_service_levels one row per scenario.
--
-- ---------------------------------------------------------------------
-- MEASURED, NOT ASSUMED
-- ---------------------------------------------------------------------
-- Postgres 16 in the container, this repo's schema loaded from 001 through
-- 080, jb_plan_day carrying the 064 patch exactly as production does.
--
-- Two stores, identical in every field. Same product, same seven sales rows,
-- same delivery days, same shelf max. The ONE difference is that LEAN STORE
-- has a store_settings row saying 'lean' and DEFAULT STORE has no row at all.
-- Both planned for Thu 3 Sep at a network z of 0.39.
--
--                     dial                forecast   BEFORE 081   AFTER 081
--     DEFAULT STORE   (network default)     10.83        13          13
--     LEAN STORE      lean                  10.83        13          12
--
-- Both halves of the claim are in that table. Before the patch the dial was
-- inert -- two identical numbers. After it, the lean store is sized down a
-- loaf and the store with no row does not move at all.
--
-- The forecast is identical in every case (10.83), which is the point: z does
-- not touch demand, only the safety stock laid on top of it.
--
-- One thing that test found the hard way, worth writing down: the first run
-- used a flat sales history, six identical days, and both stores came back
-- equal AFTER the patch as well. That was not the patch failing. With a flat
-- history the standard deviation is zero, and z multiplies the deviation --
-- so with no variation there is nothing for any service level to act on, and
-- lean and service-leaning agree exactly. A test that cannot fail is not a
-- test; the history above varies from 4 to 18 units.
--
-- The undo at the bottom of this file was also run, not just written: the
-- pre-patch body was restored from jb_fn_backup_081, produced 13 and 13
-- again, and the migration then re-applied cleanly. Re-running it a second
-- time says "already applied, leaving it alone" and changes nothing.
--
-- ---------------------------------------------------------------------
-- WHAT THIS DOES NOT DO
-- ---------------------------------------------------------------------
-- The run label still records the network z:
--
--     'newsvendor-v3-sql z=' || p_z
--
-- That is left alone on purpose. It is the level the RUN was called at, which
-- is a true and useful thing to record; the per-store overrides are visible
-- in store_settings and are not the run's identity. Changing that label would
-- also mean touching how engine_runs rows are read, five days out.
--
-- It also does not touch the Overview projection panel, which models the
-- network at three network-wide z values. That panel answers "what would
-- happen if I moved the network dial", and per-store overrides are not part
-- of that question.
--
-- ---------------------------------------------------------------------
-- HOW IT IS APPLIED
-- ---------------------------------------------------------------------
-- Self-patch through pg_get_functiondef -- the same method as 057, 062 and
-- 064. Read the live definition, substitute one anchor, re-execute. Guards:
-- the function must exist, the patch must not already be present, and the
-- anchor must appear EXACTLY ONCE. Any other count aborts without changing
-- anything, because it means the live function is not in the state this
-- migration was written against.
--
-- The full pre-patch definition is snapshotted to jb_fn_backup_081 first, so
-- the undo is one statement (bottom of this file).
--
-- Additive and idempotent.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Snapshot the live function before touching it.
-- ---------------------------------------------------------------------------
create table if not exists jb_fn_backup_081 (
  fn         text primary key,
  definition text not null,
  snapped_at timestamptz not null default now()
);

alter table jb_fn_backup_081 enable row level security;
alter table jb_fn_backup_081 force  row level security;
drop policy if exists biz_all on jb_fn_backup_081;
create policy biz_all on jb_fn_backup_081 for all
  using      ((select public.current_app_role()) = any (array['admin','manager','office']))
  with check ((select public.current_app_role()) = any (array['admin','manager','office']));

insert into jb_fn_backup_081 (fn, definition)
select 'jb_plan_day', pg_get_functiondef(p.oid)
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where p.proname = 'jb_plan_day' and n.nspname = 'public'
on conflict (fn) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The patch.
-- ---------------------------------------------------------------------------
do $patch$
declare
  src text;
  needle constant text :=
E'           c.shelf_max, c.min_on_shelf, p2.z\n'
'    from combos c';
  addition constant text :=
E'           c.shelf_max, c.min_on_shelf,\n'
'           -- 081: this store''s own service level when Simona has set one.\n'
'           --\n'
'           -- The store profile has always let her pick lean / balanced /\n'
'           -- service for a single shop, saved it, and told her "the plan\n'
'           -- re-sizes each line to match". Nothing read it. These two left\n'
'           -- joins are that promise.\n'
'           --\n'
'           -- LEFT, and coalesced, so a store with no row -- nearly all of\n'
'           -- them -- keeps the network z the run was called with, and is\n'
'           -- unchanged to the loaf.\n'
'           coalesce(esl.z, p2.z)                                 as z\n'
'    from combos c\n'
'    left join store_settings ss           on ss.store_id  = c.store_id\n'
'    left join engine_service_levels esl   on esl.scenario = ss.service_level';
  n_anchor int;
begin
  select pg_get_functiondef(p.oid) into src
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'jb_plan_day' and n.nspname = 'public';

  if src is null then
    raise exception '081: jb_plan_day does not exist. Nothing patched.';
  end if;

  if position('081: this store''s own service level' in src) > 0 then
    raise notice '081: already applied, leaving it alone.';
    return;
  end if;

  n_anchor := (length(src) - length(replace(src, needle, ''))) / length(needle);
  if n_anchor <> 1 then
    raise exception '081: anchor found % times, expected exactly 1. Nothing patched. The live function is not in the state this migration was written against.', n_anchor;
  end if;

  execute replace(src, needle, addition);
  raise notice '081: jb_plan_day patched -- the per-store dial now reaches the engine.';
end
$patch$;

commit;

-- ---------------------------------------------------------------------------
-- VERIFY. Run these three, one at a time, and read every row.
-- ---------------------------------------------------------------------------
--
-- 1. Is the patch live?
--
--   select case when pg_get_functiondef(p.oid) like '%081: this store%'
--               then 'YES - the per-store dial reaches the engine'
--               else 'NO  - PATCH DID NOT APPLY, STOP' end as patched
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where p.proname = 'jb_plan_day' and n.nspname = 'public';
--
-- 2. WHO MOVES. One row per level, not aggregated into a cell -- a truncated
--    results cell is not a measurement, which this build learned the hard way
--    on migration 078. Every store outside the 'network default' row is a
--    store whose plan can now differ from the network dial.
--
--   select coalesce(ss.service_level, 'network default') as level,
--          count(*)                                      as stores
--     from stores s
--     left join store_settings ss on ss.store_id = s.id
--    where s.active
--    group by 1
--    order by 2 desc;
--
-- 3. Name them, so the change is a list and not a number:
--
--   select s.name, s.state, ss.service_level, esl.z, ss.updated_at
--     from stores s
--     join store_settings ss        on ss.store_id  = s.id
--     join engine_service_levels esl on esl.scenario = ss.service_level
--    where s.active
--    order by ss.service_level, s.name;
--
-- ---------------------------------------------------------------------------
-- UNDO. One statement, restores the exact pre-patch body:
--
--   do $undo$
--   declare d text;
--   begin
--     select definition into d from jb_fn_backup_081 where fn = 'jb_plan_day';
--     if d is null then raise exception 'no 081 backup found'; end if;
--     execute d;
--   end $undo$;
-- ---------------------------------------------------------------------------
