-- Migration 008: seasonality events — a real, shared table
-- Moves the seasonality calendar off a UI-only seed and into the events
-- table, so the UI, the engine, and Simona's future edits all read one
-- source. Dates verified 17 Aug 2026 against Hebcal (Jewish calendar) and
-- the NSW school-term / public-holiday schedule.
--
-- ui_kind carries the calendar's visual category (jewish / weather / etc.)
-- WITHOUT touching the event_kind enum — the enum `kind` is set to the
-- closest existing value. Additive + idempotent: re-running skips any event
-- already present by (name, start_date). Safe to apply more than once.

alter table events add column if not exists scope   text;
alter table events add column if not exists note    text;
alter table events add column if not exists ui_kind text;

insert into events (name, kind, ui_kind, state, start_date, end_date, uplift_pct, scope, note)
select v.name,
       v.kind::event_kind,
       v.ui_kind,
       v.state,
       v.start_date::date,
       v.end_date::date,
       v.uplift_pct::numeric,
       v.scope,
       v.note
from (values
  ('Rosh Hashanah','store_custom','jewish', null,  '2026-09-11','2026-09-13', 12,
    'Large challah · ~6 Jewish-demographic stores',
    'Large raisin / sesame / plain challah spike. Produce Wed 9-Thu 10 for the Friday lift. Network shown +12%; challah at those stores runs far higher.'),
  ('Yom Kippur','store_custom','jewish', null, '2026-09-20','2026-09-21', -8,
    'Jewish-demographic stores',
    'Fast day dips demand, then a break-fast bread/bagel lift the evening after. Confirm timing with Simona.'),
  ('Sukkot -> Simchat Torah','store_custom','jewish', null, '2026-09-25','2026-10-04', 8,
    'Challah · ~6 Jewish-demographic stores',
    'Eight days of festive meals - a sustained challah lift at Jewish-demographic stores (Fri 25 Sep and Fri 2 Oct Shabbats are the peaks). Overlaps the spring school holidays, so at these stores challah rises while general supermarket bread falls - a clear per-store split.'),
  ('Spring school holidays','school_holiday','school', 'NSW', '2026-09-28','2026-10-09', -30,
    'Network - coastal/holiday runs flip positive',
    'Supermarket bread drops ~30% (straight to the bin on the legacy system). Exception: Central Coast & coastal runs INCREASE - this is per-store, not one number.'),
  ('Labour Day (NSW)','public_holiday','public', 'NSW', '2026-10-05','2026-10-05', 10,
    'Network · long weekend',
    'Long-weekend lift; some runs shift a day - check delivery days that week.'),
  ('Forecast heatwave','store_custom','weather', null, '2026-09-18','2026-09-19', -6,
    'Example - weather layer',
    'Example only. Hot days soften bread. The weather layer stays off until a forecast feed is wired; Simona can add days by hand.'),
  ('Christmas','retail_event','retail', null, '2026-12-18','2026-12-24', 40,
    'Network',
    'Biggest lift of the year, ~+40%. Ramp from mid-December.'),
  ('Easter','retail_event','retail', null, '2027-04-02','2027-04-05', 18,
    'Network',
    'Relevant lift around the long weekend. Confirm the basket with Simona.')
) as v(name, kind, ui_kind, state, start_date, end_date, uplift_pct, scope, note)
where not exists (
  select 1 from events e
  where e.name = v.name and e.start_date = v.start_date::date
);

-- Verify after apply:
--   select name, ui_kind, start_date, end_date, uplift_pct
--   from events order by start_date;
