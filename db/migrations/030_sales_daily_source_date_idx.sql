-- 030 — index sales_daily by (source, sale_date)
--
-- Why: feed health is "what is the latest sale_date each retailer has sent?".
-- With only (sale_date) and (store_id, sale_date) to work with, answering that
-- meant a grouped aggregate over every row in the table — 1,155,692 of them as
-- at 25 Aug 2026 — to produce three. It measured 2.2s and was the slowest query
-- on the Overview, the first screen anyone opens.
--
-- With this index, getFeedStatus() asks each retailer separately (see the
-- rewritten query in apps/web/lib/queries.ts) and each answer is a backward
-- walk of this index that stops on its first row.
--
-- CONCURRENTLY so the live app keeps reading and writing sales_daily while it
-- builds. That means this statement CANNOT run inside a transaction block: run
-- it on its own in the Supabase SQL editor, not wrapped with anything else. If
-- it fails partway it leaves an INVALID index behind — drop it and re-run:
--   drop index if exists sales_daily_source_date_idx;

create index concurrently if not exists sales_daily_source_date_idx
  on sales_daily (source, sale_date);
