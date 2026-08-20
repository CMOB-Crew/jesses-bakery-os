-- Migration 017: daily_run_state — persists the approval ticks Simona makes on
-- the production and deliveries boards for a given day, so working through a run
-- and reloading no longer wipes her progress. One row per (surface, day); the
-- approved set is JSONB (item id -> bool). Additive/idempotent. Add to 014's RLS
-- list before RLS.
create table if not exists daily_run_state (
  surface    text not null,                       -- 'production' | 'deliveries'
  day        date not null default current_date,
  approved   jsonb not null default '{}'::jsonb,   -- { itemId: true } for approved lines/stores
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (surface, day)
);
comment on table daily_run_state is
  'Per-day approval state for the production/deliveries boards (approved = itemId->bool). Keeps a run''s ticks across reloads; the individual nudges stay ephemeral, only the approval set persists.';

-- Verify:
--   select surface, day, approved from daily_run_state order by day desc;
