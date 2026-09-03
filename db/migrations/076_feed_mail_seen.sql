-- Migration 076: every email the mailbox poller has looked at, and what came
--
-- RENUMBERED from 072, which collided with 072_pita_pack_size.sql. Commit
-- a76fdc6 calls this "migration 072"; it means this file. Already applied to
-- production under the old number; nothing needs re-running.
-- of it.
--
-- Two jobs, and the second is the important one.
--
-- 1. DEDUPE. The primary key on message_id is the lock: the poller inserts the
--    row before it downloads anything, so a retry after a timeout, or two runs
--    overlapping, cannot load the same morning's report twice.
--
-- 2. EVIDENCE. Their old Coles pipeline reported Success 259,303 times while
--    loading nothing for three weeks. An automation that quietly does nothing
--    looks exactly like a quiet morning, so every message the poller matches
--    ends up here with an outcome -- loaded, failed or skipped, and why. "The
--    feed is fine" should be a claim with rows behind it.
--
-- Additive and idempotent.

create table if not exists feed_mail_seen (
  message_id   text primary key,                 -- Microsoft Graph message id
  retailer     retailer_type not null,
  subject      text,
  received_at  timestamptz,                      -- when the retailer sent it
  status       text not null default 'running',  -- running | loaded | failed | skipped
  note         text not null default '',         -- counts, or the reason it did not load
  upload_id    uuid references feed_uploads(id) on delete set null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create index if not exists feed_mail_seen_received_idx
  on feed_mail_seen (received_at desc);

comment on table feed_mail_seen is
  'One row per email the mailbox poller matched to a retailer feed. Primary key on the Graph message id is the dedupe lock; status/note are the audit trail so a silently dead feed is visible rather than indistinguishable from a quiet morning.';

-- RLS, matching 018's write-back tables. The poller runs as a real account
-- (FEED_POLL_USER_ID) with role office or higher, so biz_all covers it; without
-- an identity it would write nothing and the feed would go stale in silence,
-- which is what the route refuses to start without.
alter table feed_mail_seen enable row level security;
alter table feed_mail_seen force  row level security;

drop policy if exists biz_all on feed_mail_seen;
create policy biz_all on feed_mail_seen
  for all
  using      (public.current_app_role() in ('admin','manager','office'))
  with check (public.current_app_role() in ('admin','manager','office'));

-- Verify:
--   select retailer, status, note, received_at
--     from feed_mail_seen order by received_at desc limit 20;
