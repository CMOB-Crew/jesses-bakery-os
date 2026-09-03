-- Migration 074: a day-by-day standing order.
--
-- Simona, 1 September: "Monday through Sunday, quantity per product per day.
-- Not a weekly total. These stores ring me all the time and say hey, can you up
-- Wednesday? Hey, can you cancel Wednesday's delivery? Hey, on Friday can you
-- send me nine more bags?"
--
-- Until now the only thing a person could set was a WEEKLY number
-- (store_product_overrides.qty), which the packing sheet then split across that
-- store's delivery days. That can express "more of this" but it cannot express
-- "more on Wednesday", and it cannot express "none on Wednesday" at all.
--
-- THE RULE THIS TABLE INTRODUCES, and it matters:
--
--   If a (store, product) has ANY row here, this grid defines that line for
--   EVERY day, and every other source is suppressed for it.
--
-- That is what makes "cancel Wednesday" possible. If the other sources still
-- applied, a 0 on Wednesday would simply be refilled by last week's carry
-- forward and the cancellation would silently do nothing -- which is exactly
-- the class of bug this system keeps finding in the old one. A missing row is
-- read as zero, deliberately: the grid is a complete statement of the week.
--
-- qty 0 IS MEANINGFUL and is why the check allows it. Zero here means "do not
-- deliver this on this day", which is different from having no row at all.
--
-- Still gated on the store's delivery days when the packing sheet reads it: a
-- number against a day with no van is not a delivery, and the screen only
-- offers the days that store is actually delivered.
--
-- Additive and idempotent.

create table if not exists store_product_days (
  store_id    uuid not null references stores(id)   on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  dow         weekday not null,
  qty         int not null default 0 check (qty >= 0),
  updated_at  timestamptz not null default now(),
  updated_by  text,
  primary key (store_id, product_id, dow)
);

create index if not exists store_product_days_store_idx
  on store_product_days (store_id);

comment on table store_product_days is
  'Day-by-day standing order for one customer and product. If a (store, product) has ANY row here, this grid defines that line for every day and the weekly override, the engine plan and last week''s carry-forward are all suppressed for it -- otherwise a zero could never mean "cancel Wednesday", it would just be refilled. qty 0 means do not deliver that day, which is not the same as having no row.';

comment on column store_product_days.qty is
  'Units on this weekday. 0 is a real instruction (cancel that day), not an absence.';

-- RLS, matching 018's write-back tables.
alter table store_product_days enable row level security;
alter table store_product_days force  row level security;

drop policy if exists biz_all on store_product_days;
create policy biz_all on store_product_days
  for all
  using      (public.current_app_role() in ('admin','manager','office'))
  with check (public.current_app_role() in ('admin','manager','office'));

-- Verify:
--   select s.name, p.name, d.dow, d.qty
--     from store_product_days d
--     join stores s on s.id = d.store_id
--     join products p on p.id = d.product_id
--    order by s.name, p.name, d.dow;
