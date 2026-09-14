-- Migration 099: the photographs had no backup of any kind.
--
-- WHAT WAS WRONG
--
-- Condition 9 of @Fred's August record: "point-in-time recovery plus an
-- independent weekly dump into storage Jesse controls." Neither existed.
--
-- PITR is an unpurchased Supabase add-on, declined on 11 September for good
-- reasons -- US$100/month, outside the spend cap, and Postgres only. But the
-- "Postgres only" is the part that matters here, because Supabase's own
-- documentation says it in one line:
--
--   "Database backups do not include objects you store via the Storage API."
--
-- So the delivery photographs and the customers' signatures are in NO backup.
-- Not a weaker one. None. The signed record survives in Postgres and the
-- image -- the thing that actually settles a retailer dispute -- does not.
--
-- The weekly-dump signer shipped on 12 September (4543450). The sync, the
-- route, the schedule and the destination bucket did not, so nothing has ever
-- copied a single object anywhere.
--
-- WHAT THIS ADDS
--
-- Two tables and nothing else. No existing table, policy or row is touched.
--
--   backup_runs     one row per attempt, successful or not
--   backup_objects  one row per object that has actually been copied
--
-- WHY TWO TABLES AND NOT ONE
--
-- They answer different questions and only one of them is the alarm.
--
-- backup_objects answers "is this photograph safe", which is a join away from
-- delivery_photos and needs a row per object.
--
-- backup_runs answers "is the backup still running at all", which is the
-- question that actually bites. @Fred, 14 September: "The secret on this app
-- expires and when it does the backup silently stops - same way
-- TriggerForecastRefreshADF died." Four of the eight app registrations in
-- Jesse's tenant already have expired secrets. A backup that stops is
-- indistinguishable from a backup that has nothing to do, unless something
-- records the attempts -- so a run is written when it STARTS, not when it
-- succeeds, and a run that never finished stays visible as 'running' forever.
--
-- WHY storage_path IS THE KEY
--
-- One backup per source object, and re-running is free. The sha256 is carried
-- so a changed object is detectable, but nothing here ever deletes: the
-- expensive and dangerous operations are the ones deliberately not built.

create table if not exists backup_runs (
  id                  uuid primary key default gen_random_uuid(),
  -- Written at the START. A row stuck in 'running' is how a job that died
  -- mid-flight stays visible; a job that only wrote on success would leave
  -- no trace at all of the attempt that killed it.
  started_at          timestamptz not null default now(),
  finished_at         timestamptz,
  status              text not null default 'running'
                      check (status in ('running', 'ok', 'failed')),
  -- Which destination this run wrote to. Recorded rather than assumed,
  -- because the destination changed once already (R2 -> SharePoint) and the
  -- history should say which objects went where.
  destination         text not null,
  objects_considered  integer not null default 0,
  objects_uploaded    integer not null default 0,
  objects_skipped     integer not null default 0,
  bytes_uploaded      bigint  not null default 0,
  -- Present only on 'failed'. Never carries a credential: the transports
  -- derive from their secrets and never return them.
  error               text
);

create index if not exists backup_runs_started_idx
  on backup_runs (started_at desc);

-- The staleness question, asked often enough to deserve an index that
-- answers it without a sort over the whole table.
create index if not exists backup_runs_last_ok_idx
  on backup_runs (finished_at desc) where status = 'ok';

create table if not exists backup_objects (
  -- The path in OUR storage. One backup per source object.
  storage_path  text primary key,
  -- What we copied. If the source object is ever replaced, this stops
  -- matching and the sync picks it up again.
  sha256        text not null,
  bytes         bigint not null,
  -- Where it landed. Kept in full so a restore does not have to re-derive it
  -- from a naming rule that may have changed since.
  remote_path   text not null,
  destination   text not null,
  uploaded_at   timestamptz not null default now(),
  -- SET NULL rather than CASCADE: losing the run history must never delete
  -- the record of a photograph being safe.
  run_id        uuid references backup_runs(id) on delete set null
);

create index if not exists backup_objects_run_idx
  on backup_objects (run_id);

-- Row-level security, matching the house pattern in 014 and after. These hold
-- no personal data -- a storage path, a checksum and a byte count -- but
-- every other table in this schema is covered and an uncovered one is how
-- condition 1 stopped being true the first time.
alter table backup_runs    enable row level security;
alter table backup_runs    force row level security;
alter table backup_objects enable row level security;
alter table backup_objects force row level security;

-- Office and admin can read the backup's own health. Nobody writes from a
-- browser: the only writer is the weekly job, which runs as the service role.
drop policy if exists backup_runs_read on backup_runs;
create policy backup_runs_read on backup_runs
  for select using (
    coalesce(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role', '')
      in ('admin', 'office')
  );

drop policy if exists backup_objects_read on backup_objects;
create policy backup_objects_read on backup_objects
  for select using (
    coalesce(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role', '')
      in ('admin', 'office')
  );
