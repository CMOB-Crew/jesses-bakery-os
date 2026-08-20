-- Migration 018: RLS for the write-back tables + engine_projection -- DRAFT / HOLD
-- Companion to 014. These tables didn't exist when 014 was written:
--   store_product_ranging, store_settings   -> created in 015
--   app_settings                            -> created in 016
--   daily_run_state                         -> created in 017
--   engine_projection                       -> created in 005 (missed by 014)
-- Keeping them here (rather than in 014's list) is what lets the migration set
-- apply cleanly in numeric order.
--
-- ============================ DO NOT APPLY YET ============================
-- Same precondition as 014: the request path must carry a verified user
-- (AUTH_ENFORCED=1, the runAsUser wrapper deployed) before this goes on, or
-- every non-wrapper query sees zero rows. Apply immediately after 014.
-- =========================================================================
--
-- Model matches 014: admin/manager/office get full business access; role NULL
-- gets nothing (deny-by-default); the engine writes under its own BYPASSRLS
-- role and is deliberately not granted here.

-- ---------------------------------------------------------------------------
-- Write-back tables: same deny-by-default + biz_all pass as 014.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  biz text[] := array[
    'store_product_ranging','store_settings','app_settings','daily_run_state'
  ];
begin
  foreach t in array biz loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);

    execute format('drop policy if exists biz_all on %I', t);
    execute format($p$
      create policy biz_all on %I
        for all
        using      (public.current_app_role() in ('admin','manager','office'))
        with check (public.current_app_role() in ('admin','manager','office'))
    $p$, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- engine_projection: the engine's output, read by the app (engine panel + the
-- security_invoker reporting views). Under enforced RLS a business user reading
-- it must match a policy, so give business roles READ. The engine itself writes
-- under its BYPASSRLS role, so it needs no write policy here -- and NOT granting
-- write to business roles keeps the projection something only the engine
-- produces. (Flagged by the RLS coverage check as the one table 014 missed.)
-- ---------------------------------------------------------------------------
alter table engine_projection enable row level security;
alter table engine_projection force  row level security;

drop policy if exists biz_read_engine_projection on engine_projection;
create policy biz_read_engine_projection on engine_projection
  for select
  using (public.current_app_role() in ('admin','manager','office'));

-- Verify after apply (should return no rows -- every base table has RLS):
--   select relname from pg_class
--   where relkind='r' and relnamespace='public'::regnamespace
--     and not relrowsecurity;
