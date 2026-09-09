-- feed-mail-claim-takeover.sql
--
-- The one clause in the mailbox poller that can lose a day's sales.
--
-- feed_mail_seen is the poller's lock. A message is claimed before it is
-- worked on so two runs can never load the same report twice. Until
-- 10 September that claim was permanent, and a run killed by the platform
-- mid-message stranded it forever -- four messages went that way in one
-- morning, one of them a day we were actively trying to recover, and the fix
-- was a hand-written DELETE against production.
--
-- The claim now takes over a stale one. Everything rests on the WHERE in the
-- conflict clause, and getting it slightly wrong is silent in both directions:
-- too loose and a loaded report is ingested again, too tight and stranded
-- stays stranded.
--
-- This runs the four cases that matter against a real Postgres. It needs a
-- throwaway database -- it writes -- so it is not in CI:
--
--   psql "$THROWAWAY_DATABASE_URL" -f db/checks/feed-mail-claim-takeover.sql
--
-- Expected, and asserted below rather than left to the reader:
--
--   a message never seen      claimed
--   status 'loaded'           NOT claimed, row untouched
--   status 'failed'           NOT claimed, row untouched
--   'running' 20 seconds ago  NOT claimed  <- a run in flight keeps its work
--   'running' 40 minutes ago  claimed      <- whoever held it is not coming back

begin;

create temporary table feed_mail_seen (
  message_id  text primary key,
  retailer    text,
  subject     text,
  received_at timestamptz,
  status      text,
  note        text,
  upload_id   uuid,
  started_at  timestamptz default now(),
  finished_at timestamptz
) on commit drop;

insert into feed_mail_seen (message_id, retailer, subject, status, note, started_at, finished_at) values
  ('done',     'coles', 'daily',  'loaded',  '860 loaded', now() - interval '2 days',     now() - interval '2 days'),
  ('refused',  'coles', 'weekly', 'failed',  'weekly',     now() - interval '2 days',     now() - interval '2 days'),
  ('inflight', 'wool',  'daily',  'running', '',           now() - interval '20 seconds', null),
  ('stranded', 'wool',  'daily',  'running', '',           now() - interval '40 minutes', null);

create temporary table claim_result (message_id text, claimed boolean) on commit drop;

do $$
declare
  m text;
  got text;
begin
  foreach m in array array['newmsg', 'done', 'refused', 'inflight', 'stranded'] loop
    -- Character for character the statement in app/api/feeds/mail-poll/route.ts.
    insert into feed_mail_seen (message_id, retailer, subject, received_at, status, note)
    values (m, 'coles', 'subj', now(), 'running', '')
      on conflict (message_id) do update
         set status = 'running', note = '', started_at = now(), finished_at = null
       where feed_mail_seen.status = 'running'
         and feed_mail_seen.started_at < now() - '10 minutes'::interval
    returning message_id into got;

    insert into claim_result values (m, got is not null);
  end loop;
end $$;

-- Assertions. A failure raises rather than printing something to skim past.
do $$
declare
  bad text;
begin
  select string_agg(message_id || ' claimed=' || claimed, ', ')
    into bad
    from claim_result
   where claimed <> (message_id in ('newmsg', 'stranded'));
  if bad is not null then
    raise exception 'WRONG CLAIM OUTCOME: %', bad;
  end if;

  if not exists (
    select 1 from feed_mail_seen
     where message_id = 'done' and status = 'loaded'
       and note = '860 loaded' and finished_at is not null
  ) then
    raise exception 'a LOADED report was modified by a claim attempt';
  end if;

  if not exists (
    select 1 from feed_mail_seen
     where message_id = 'refused' and status = 'failed' and note = 'weekly'
  ) then
    raise exception 'a FAILED report was modified by a claim attempt';
  end if;

  if not exists (
    select 1 from feed_mail_seen
     where message_id = 'inflight'
       and started_at < now() - interval '10 seconds'
  ) then
    raise exception 'a run IN FLIGHT had its claim stolen';
  end if;

  if not exists (
    select 1 from feed_mail_seen
     where message_id = 'stranded'
       and started_at > now() - interval '10 seconds'
  ) then
    raise exception 'a STRANDED claim was not taken over';
  end if;

  raise notice 'All five cases behave correctly.';
end $$;

rollback;
