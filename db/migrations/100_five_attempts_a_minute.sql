-- Migration 100: a hundred guesses were free.
--
-- Condition 7 of @Fred's August record: "Rate limiting on login and password
-- reset. Five attempts per minute per identifier, logged."
--
-- Nothing in the codebase implemented it. Verified again 14 September by
-- grepping every route and library in apps/web: no limiter, no counter, no
-- lockout, nothing. Supabase Auth applies its own limits and those are real,
-- but they are not this condition -- not five a minute, not per identifier,
-- and nothing logged anywhere we can read.
--
-- WHY IT STOPPED BEING THEORETICAL THIS MORNING
--
-- Six drivers were provisioned with BDriver<nn>! and the logins went to
-- Simona to hand out. That shape was a deliberate, recorded trade: the floor
-- could not type bread-oven-tray-42 at 4am with cold hands. But it means
--
--   * a hundred possible passwords per driver, about 6.6 bits
--   * every driver knows the pattern, because every driver has one
--
-- and with no limiter, those hundred guesses cost nothing. One driver can
-- sign in as another. provision-users.mjs says so in its own header:
-- "Closing condition 7 is what makes this shape defensible; until then it is
-- exposed."
--
-- It matters beyond the account itself. saveDeliveryProof stamps
-- deliveries.driver_sig_name from the session, and that name is what settles
-- a retailer dispute. A login a colleague can guess is a signature that
-- proves nothing -- the same failure as the drawn placeholder that was being
-- filed as proof of delivery until 11 September.
--
-- WHAT THIS ADDS
--
-- One table. Additive; no existing table, policy or row is touched.
--
-- IT IS ALSO THE LOG. The condition says "logged", and a limiter that counts
-- in memory satisfies the counting and not the logging -- and on Netlify,
-- where each function instance has its own memory and instances come and go,
-- it would not even satisfy the counting. A row per attempt is both.
--
-- WHY IT DOES NOT BECOME CONDITION 8
--
-- Condition 8 is unmet because nothing purges anything and the rows
-- accumulate forever. This table would do exactly the same thing -- a row per
-- login attempt, per person, per day, indefinitely -- so the purge is built
-- into the write path rather than left as a follow-up nobody schedules. The
-- limiter only ever reads the last sixty seconds; anything older than a day
-- is kept purely so a person can look at yesterday.

create table if not exists login_attempts (
  id            bigserial primary key,
  -- lower(email). The bucket the limit is keyed on. Lowercased at the point
  -- of writing, because "Sam@" and "sam@" being two buckets would make the
  -- limit trivially bypassable by holding down shift.
  identifier    text not null,
  kind          text not null check (kind in ('signin', 'reset')),
  -- 'failed'  a wrong password, which is what counts toward the limit
  -- 'blocked' the limiter refused before Supabase was ever asked
  -- 'ok'      a successful sign-in, recorded but NOT counted
  outcome       text not null check (outcome in ('failed', 'blocked', 'ok')),
  attempted_at  timestamptz not null default now(),
  -- Forensics only. The limit is per identifier, per the condition's own
  -- wording -- keying on IP as well would lock out a whole bakery behind one
  -- router the moment two drivers fat-finger a password.
  ip            text
);

-- The only read the limiter makes: this identifier, this last minute.
create index if not exists login_attempts_window_idx
  on login_attempts (identifier, attempted_at desc);

-- The purge's read.
create index if not exists login_attempts_age_idx
  on login_attempts (attempted_at);

-- Row-level security, matching the house pattern. This table holds every
-- email address that has ever tried to sign in, which is a staff list, so an
-- uncovered table here is worse than most.
alter table login_attempts enable row level security;
alter table login_attempts force row level security;

-- Nobody reads this from a browser except an admin looking at it deliberately.
drop policy if exists login_attempts_read on login_attempts;
create policy login_attempts_read on login_attempts
  for select using (
    coalesce(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role', '')
      = 'admin'
  );

-- ---------------------------------------------------------------------------
-- THE APP NEVER TOUCHES THIS TABLE DIRECTLY, AND THAT IS THE WHOLE PROBLEM
-- THIS SOLVES.
--
-- A rate limiter runs BEFORE anybody is signed in. There is no session, so
-- there are no claims, so under forced row-level security the app can neither
-- read the count it needs nor write the row it must -- the limiter would fail
-- silently and permanently, which is the exact failure this codebase keeps
-- finding.
--
-- The obvious fixes are both wrong. Dropping FORCE would make this the one
-- uncovered table in the schema, which is how condition 1 stopped being true
-- the first time. Running the limiter on the service role would hand the
-- login path a connection that bypasses RLS on all 50 tables, to count rows
-- in one.
--
-- So: three SECURITY DEFINER functions, and the table stays locked. The app
-- can ask "how many failures", say "here is an attempt", and drop what is
-- older than a day. It cannot read the log, which is a staff list of everyone
-- who has ever tried to sign in.
--
-- Granted to PUBLIC rather than to a named role, deliberately. Neither
-- function leaks anything: the caller already supplied the identifier, and a
-- count of recent failures for an address you are already guessing at tells
-- an attacker nothing they cannot learn by trying. Naming a role here would
-- couple this migration to whichever role the app happens to connect as,
-- which has already changed once.
--
-- `set search_path = public` on all three: a SECURITY DEFINER function
-- without it is the classic Postgres privilege-escalation footgun.
-- ---------------------------------------------------------------------------

create or replace function login_failures_in_window(p_identifier text, p_seconds integer)
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::integer
    from login_attempts
   where identifier = p_identifier
     and outcome = 'failed'
     and attempted_at > now() - make_interval(secs => p_seconds)
$$;

create or replace function login_attempt_record(
  p_identifier text, p_kind text, p_outcome text, p_ip text
) returns void
language sql
security definer
set search_path = public
as $$
  insert into login_attempts (identifier, kind, outcome, ip)
  values (p_identifier, p_kind, p_outcome, p_ip)
$$;

-- The purge, on the write path rather than as a scheduled job nobody sets up.
create or replace function login_attempts_purge(p_hours integer)
returns void
language sql
security definer
set search_path = public
as $$
  delete from login_attempts
   where attempted_at < now() - make_interval(hours => p_hours)
$$;

revoke all on function login_failures_in_window(text, integer) from public;
revoke all on function login_attempt_record(text, text, text, text) from public;
revoke all on function login_attempts_purge(integer) from public;
grant execute on function login_failures_in_window(text, integer) to public;
grant execute on function login_attempt_record(text, text, text, text) to public;
grant execute on function login_attempts_purge(integer) to public;
