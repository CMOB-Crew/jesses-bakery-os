-- CI ONLY -- do NOT run against any real database.
--
-- The migrations are written for Supabase, which supplies four things a vanilla
-- Postgres does not. On 10 September all 89 migrations were applied to an empty
-- Postgres 16 for the first time and five of the eleven failures were nothing
-- but these absences. They are stubbed here so a failure in CI means a real
-- problem with a migration.
--
-- Each stub is the SMALLEST thing that lets the migration run. None of them
-- behaves like the real object, and nothing in CI should depend on them doing
-- anything -- if a test ever needs pg_cron to actually schedule something, this
-- file is the wrong tool.

-- 1. Auth. Referenced by 012 onward: auth.users, auth.uid().
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;

-- 2. The application role. 033 grants to it. On Supabase it is the role
--    DATABASE_URL points at once AUTH_ENFORCED is on.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'jbo_app') then
    create role jbo_app nologin;
  end if;
end $$;

-- 3. pg_cron. 034 schedules the nightly engine, 045 refuses to run without it,
--    070 and 089 read cron.job_run_details to report whether the engine is
--    alive. The extension is not installable in a plain container, so the two
--    objects those migrations touch are stubbed empty.
create schema if not exists cron;
create table if not exists cron.job (
  jobid    bigserial primary key,
  schedule text,
  command  text,
  jobname  text
);
create table if not exists cron.job_run_details (
  jobid       bigint,
  runid       bigserial primary key,
  job_pid     int,
  database    text,
  username    text,
  command     text,
  status      text,
  return_message text,
  start_time  timestamptz,
  end_time    timestamptz
);
-- 045 calls this and stops the whole run if pg_cron is missing, which is
-- correct against production and wrong in CI.
create or replace function cron.schedule(jobname text, schedule text, command text)
  returns bigint language sql as $$ select 0::bigint $$;
create or replace function cron.unschedule(jobname text)
  returns boolean language sql as $$ select true $$;

-- 4. Storage. 080 creates the private driver-proof bucket.
create schema if not exists storage;
create table if not exists storage.buckets (
  id                 text primary key,
  name               text,
  public             boolean,
  file_size_limit    bigint,
  allowed_mime_types text[]
);
create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text,
  name       text,
  owner      uuid,
  created_at timestamptz default now()
);
