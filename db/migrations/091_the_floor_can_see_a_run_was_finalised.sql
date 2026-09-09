-- 091_the_floor_can_see_a_run_was_finalised.sql
--
-- Packing's Finalise button has never done anything. It raised a toast reading
-- "Not saved and not sent to drivers yet -- that is the next phase" and that
-- was the whole feature. The floor's handoff to the road is still a person
-- calling out that a run is done.
--
-- What was missing turned out NOT to be the data. app/driver/page.tsx already
-- calls getPackingRuns(today) -- the identical query the packing screen uses --
-- so a driver has always seen the same stops and the same quantities. What
-- nobody could see is whether the run is FINISHED, or who finished it, or when.
--
-- So this is one more surface on daily_run_state, 'packing_final', holding
-- { runId: { at, by } }. No new table: 017 made that store deliberately
-- generic and 075 and 078 are the pattern for letting the floor at it.
--
-- WHY THE POLICIES ARE THE POINT
--
-- A driver may SELECT daily_run_state only where surface = 'driver' (075). A
-- packer only where surface = 'packing' (078). Add a surface and the floor
-- cannot see it -- silently, because RLS returns no rows rather than an error.
-- That exact bug has now been fixed three times on this table: 071, 075 and
-- 078. Adding the surface without adding the policy would have been the fourth,
-- and it would have shipped looking like it worked, because every test would be
-- run by somebody signed in as an admin.
--
--   packer   read, insert, update   -- they are the ones who finalise
--   driver   read ONLY              -- a driver must never mark a run packed
--
-- No DELETE for anyone, same reasoning as 078: this is a record of what was
-- handed over.
--
-- Idempotent. Safe to run more than once.

begin;

drop policy if exists packer_run_final_read   on daily_run_state;
drop policy if exists packer_run_final_insert on daily_run_state;
drop policy if exists packer_run_final_update on daily_run_state;
drop policy if exists driver_run_final_read   on daily_run_state;

create policy packer_run_final_read on daily_run_state
  for select using ((select public.current_app_role()) = 'packer' and surface = 'packing_final');

create policy packer_run_final_insert on daily_run_state
  for insert with check ((select public.current_app_role()) = 'packer' and surface = 'packing_final');

create policy packer_run_final_update on daily_run_state
  for update using      ((select public.current_app_role()) = 'packer' and surface = 'packing_final')
             with check ((select public.current_app_role()) = 'packer' and surface = 'packing_final');

-- Read only. A driver seeing "this run is packed" is the entire point; a driver
-- being able to declare it packed is not.
create policy driver_run_final_read on daily_run_state
  for select using ((select public.current_app_role()) = 'driver' and surface = 'packing_final');

commit;

-- Verify -- expect four rows, and note that only the packer ones are not SELECT:
--
--   select policyname, cmd from pg_policies
--    where tablename = 'daily_run_state' and policyname like '%run_final%'
--    order by policyname;
