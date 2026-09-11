-- 094_the_app_could_not_see_the_bucket.sql
--
-- The proof-of-delivery audit went live and its first run said:
--
--   {"ok":false,"error":"permission denied for schema storage"}
--
-- 9e7c48e reads `storage.objects` to answer "is every signature still there"
-- in one query rather than 1,900 Storage API calls. That table was checked in
-- the Supabase SQL editor before the design was chosen -- 4 objects in
-- driver-proof, all dated 2026-09-04 -- and the SQL editor connects as
-- postgres, a superuser. The app does not.
--
-- Checked in the easy place, not the place it runs. The August notes already
-- carry the same lesson in different words: "Never benchmark as postgres -- it
-- has BYPASSRLS and hides policy cost."
--
-- WHY THIS IS NOT `grant select on storage.objects`
--
-- Because that would have been worse than the error. Supabase keeps
-- row-level security ON storage.objects -- it is how bucket rules are
-- enforced -- and RLS RETURNS NO ROWS RATHER THAN AN ERROR. Grant the select,
-- leave the policies alone, and the audit sees an empty bucket:
--
--   every recorded proof reads as MISSING, every week, for ever
--
-- and the moment somebody got tired of that and "fixed" it by relaxing the
-- comparison, the audit would go green over a bucket it cannot see. A check
-- that cannot tell "nothing is there" from "I cannot look" is the exact bug
-- this whole week has been spent removing.
--
-- A permission error is the better failure. It is loud, it names itself, and
-- it cannot be mistaken for a clean result.
--
-- WHAT THIS DOES INSTEAD
--
-- One security-definer function, owned by the migration runner, returning ONLY
-- the driver-proof bucket. Definer so it reads past both the schema grant and
-- the RLS policies; no bucket parameter so it can never be pointed at
-- feed-uploads or anything added later; metadata only -- names, sizes and
-- timestamps, never a byte of any object.
--
-- search_path is pinned. A security-definer function without one is the
-- classic Postgres privilege-escalation hole: the caller sets search_path,
-- puts their own `objects` table in front of storage's, and the function reads
-- it as the owner.
--
-- Execute is granted to jbo_app and revoked from public. If the site connects
-- as something else the audit will fail again, and again loudly -- the verify
-- block at the bottom runs it as jbo_app so that is settled here rather than
-- on the next scheduled run.
--
-- Idempotent.

begin;

drop function if exists public.jb_proof_objects();

create function public.jb_proof_objects()
returns table (name text, size bigint, created_at timestamptz)
language sql
stable
security definer
-- Pinned, and storage is NOT on it: the function names storage.objects in
-- full below, so nothing resolves through a caller-controlled path.
set search_path = pg_catalog, public
as $fn$
  select o.name::text,
         (o.metadata ->> 'size')::bigint,
         o.created_at
    from storage.objects o
   where o.bucket_id = 'driver-proof'
$fn$;

comment on function public.jb_proof_objects() is
  'Object metadata for the driver-proof bucket only: name, size, created_at. Never object contents. Exists because the app role has no access to the storage schema, and because granting it would have left Supabase''s RLS on storage.objects silently returning zero rows -- which the audit would have read as "every proof of delivery is missing". Security definer with a pinned search_path; no bucket parameter, so it cannot be pointed anywhere else. Migration 094, 10 September.';

revoke all on function public.jb_proof_objects() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'jbo_app') then
    execute 'grant execute on function public.jb_proof_objects() to jbo_app';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- AND THE SECOND HALF, WHICH IS THE ONE THAT NEARLY GOT MISSED
--
-- Fixing the storage permission alone would have made this audit LIE.
--
-- delivery_photos has row-level security, enabled AND forced, since migration
-- 014. current_app_role() reads auth.uid(), a scheduled call has no session,
-- so the role is null, every policy is false, and the table returns NO ROWS
-- rather than an error. The audit would then have read:
--
--   0 proofs recorded, 0 missing, 0 changed  ->  ok:true
--
-- A green tick, every Monday, over a table it cannot see. That is strictly
-- worse than the "permission denied" it started with, and it is the same bug
-- as the one this audit exists to catch -- an absence read as an all-clear.
--
-- So the audit is given a way to check its own eyesight: the TRUE number of
-- rows, read past RLS, to compare against what it can actually see. Different
-- numbers mean the audit is blind and must say so instead of reporting a
-- clean result.
--
-- A count. Not the rows -- no paths, no checksums, no GPS, no signer names.
-- ---------------------------------------------------------------------------
drop function if exists public.jb_proof_row_count();

create function public.jb_proof_row_count()
returns bigint
language sql
stable
security definer
set search_path = pg_catalog, public
as $fn$
  select count(*) from public.delivery_photos
$fn$;

comment on function public.jb_proof_row_count() is
  'How many delivery_photos rows there really are, read past RLS. The audit compares this against what it can see: fewer visible than actual means it is blind, and a blind audit must report that rather than a clean result. Returns a count and nothing else -- no paths, checksums, GPS or signer names. Migration 094, 10 September.';

revoke all on function public.jb_proof_row_count() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'jbo_app') then
    execute 'grant execute on function public.jb_proof_row_count() to jbo_app';
  end if;
end $$;

commit;

-- Verify. Run BOTH, and the second is the one that matters -- the first passes
-- as postgres whether or not this migration did anything useful:
--
--   select count(*) from public.jb_proof_objects();
--
--   begin;
--     set local role jbo_app;
--     select count(*) as visible_to_the_app from public.jb_proof_objects();
--   rollback;
--
-- Expect the same number from both. On 10 September that number is 4.
--
-- If the second says "permission denied", the site connects as some role other
-- than jbo_app, and that role needs the same grant.
--
-- Then the eyesight test. This is the one that says whether the audit can see
-- the table it is auditing:
--
--   begin;
--     set local role jbo_app;
--     select public.jb_proof_row_count()        as actually_there,
--            (select count(*) from delivery_photos) as visible_to_the_app;
--   rollback;
--
-- Two different numbers is not a failure of this migration -- it is the audit
-- being blind, which is exactly what the second column exists to reveal. The
-- endpoint now refuses to report a clean result when they disagree.
