-- Migration 010: product launch tracking
-- Source: Simona, 16 Aug 2026 (WhatsApp): "When I launch something new, track it
--   separately" -- units moved, sell-through, which stores took it. The store
--   version shipped first (migrations 009 + launch controls); this is the same
--   idea for a new product line.
--
-- Adds one nullable column, mirroring stores.onboarded_at:
--   * launched_at = the date a product line was launched. Set it (from the
--     Products page, no SQL needed) when a new line goes out, and the product is
--     tracked on the Launches page for its first 6 weeks -- stores ranging it,
--     units sold, sell-through, waste -- then it graduates to the normal
--     Products view.
--
-- No seed: there is no launched line yet. The Harris Farm Choc Babka is the
-- first candidate once its product code lands.
--
-- Idempotent: the column add is guarded. Safe to run more than once.

alter table products add column if not exists launched_at date;

comment on column products.launched_at is
  'Launch date for a new product line. Set when the line goes out; the product is tracked on the Launches page for 6 weeks from this date. Null = an established line, not a tracked launch.';

-- Verify after apply:
--   select name, category, launched_at, active
--   from products where launched_at is not null
--   order by launched_at desc;
