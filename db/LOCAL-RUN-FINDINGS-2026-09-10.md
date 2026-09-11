# What running it locally found — 10 and 11 September 2026

These were found while standing the app up from this repository on a laptop and
using every screen. The setup was Postgres 16 in Docker, rebuilt with
`db/checks/rebuild-from-migrations.sh` and seeded with `db/seed/seed.py`.
Everything was re-checked on 11 September on this branch, after merging main.

This file covers everything that is not row-level security or performance:

- Row-level security: `db/RLS-AUDIT-2026-09-10.md`
- Performance: `PERFORMANCE-AUDIT.md`, with the fix plan in `PERFORMANCE-FIXES.md`

---

## 1. The assistant still reads the two columns `91d8eeb` stopped using

`91d8eeb` (10 September) found that `store_reco.sent` and `store_reco.sold`
"have never been written by anything". They hold whatever the legacy load put
there, and zero for every row created since 088. That commit moved the Products
page off them. `apps/web/lib/ask.ts` still reads them in two places:

| Line | The question that reaches it | What it reports from the old columns |
|---|---|---|
| `lib/ask.ts:76` | a product category, e.g. "how are the bagels doing" | `sum(r.sold)` as this week's sales for the category |
| `lib/ask.ts:103` | **"What should we cut?"**, a suggestion chip on both the Overview and `/assistant` | ranks lines by `sent - recommended` and quotes `sold` in the headline |

On the rebuilt database, after the engine ran, **0 of 588 `store_reco` rows have
a non-zero `sold` or `sent`**. This is what "What should we cut?" answers:

> Mini Challah is the most over-supplied line — sending 0 a week across the
> worst stores where 0 sells. The plan would send 18,467.

Every bar in the chart is negative, and the ranking is upside down: the line
named as most over-supplied is the one with the *smallest* cut.

In production the legacy rows still hold numbers, so the sentence reads as if it
were true. It is a snapshot from before go-live presented as this week's figures,
and every line added since 088 counts as zero. The screen above it promises
*"exact numbers, never guessed"*, and each answer is labelled *"Live query ·
Woolworths feed"* (`components/AssistantBoard.tsx:67`, `:138`).

It is the same bug as `91d8eeb`, in the one place that commit did not reach.

**Fix direction.** No schema change is needed. Do what `91d8eeb` did: measure
sold and delivered over the seven days ending `jb_asof()` (the window
`v_store_week` uses), and keep `sent` only for what it really is, the standing
order. The "How I got this" strings at `lib/ask.ts:89` and `:113` need the same
change, or the disclosure will show a query the answer did not come from.

---

## 2. A seeded local copy cannot run the production engine

Production plans with `jb_run_engine`, which pg_cron calls every night (see
`services/forecast/sql/README.md`). On a local copy:

- **`db/seed/seed.py` never sets `stores.delivery_days`**, so all 84 seeded
  stores have `{}`. The engine only plans a store for a day listed in its
  delivery days (089, the `= any(st.delivery_days)` test). So running
  `call jb_run_engine(28, null, 'local')` plans nothing and raises
  `jb_run_engine run 1 failed: no day in … planned anything`.
- **The README's "Run it locally" section uses the Python service's `POST /plan`
  instead.** That writes `replenishment_plans` but neither `engine_runs` nor
  `store_reco`. The Overview therefore shows *"The plan has never been built"*,
  and every assistant question that reads `store_reco` falls back to the
  generic answer.

Without hand-patching data, nobody can run the production engine on a local
copy, or check any screen that depends on its output.

This is the workaround used for this audit. Run it only on a throwaway
database, never on production. It gives every store the delivery days confirmed
in `db/load-runs.sql`:

```sql
update runs rn set run_days = v.days::weekday[]
from regions r, (values
  ('CANBERRA',         array['tue','fri']),
  ('CENTRAL COAST',    array['mon','wed','sat']),
  ('CITY',             array['mon','wed','fri']),
  ('EASTERN SUBURBS',  array['mon','tue','wed','thu','fri','sat','sun']),
  ('HILLS',            array['mon','wed','sat']),
  ('INNER WEST',       array['mon','wed','fri','sat']),
  ('NEWCASTLE',        array['tue','thu','sat']),
  ('NORTH SHORE',      array['tue','thu','fri','sat','sun']),
  ('NORTHWEST',        array['mon','wed','fri','sat']),
  ('NORTHERN BEACHES', array['tue','thu','fri','sat','sun']),
  ('SOUTH',            array['mon','wed','sat']),
  ('WESTERN SYDNEY',   array['mon','thu','sat'])
) as v(region, days)
where rn.region_id = r.id and upper(r.name) = v.region;

update stores s set delivery_days = rn.run_days
from runs rn where rn.id = s.default_run_id and s.delivery_days = '{}';

call jb_run_engine(28, null, 'local-run');
```

Result: 9,268 plans, 588 `store_reco` rows, and `jb_engine_health()` reports
`ok`.

**Fix direction.** Have `seed.py` set `delivery_days` from the same schedule.
Have the README call `jb_run_engine` after seeding, and say that `POST /plan` is
not what production runs.

---

## 3. A local database built before 11 September cannot apply 094

On 11 September, main's update to `db/checks/ci-auth-stub.sql` added
`storage.objects.metadata`. A database built with the older stub fails 094 with
`column o.metadata does not exist`. CI rebuilds from scratch on every run, so it
is not affected. `CLAUDE.md` points every agent at a long-lived local database on
port 5433, so an older database will hit this. Either rebuild it, or run the two
new stub statements first:

```sql
alter table storage.objects add column if not exists metadata jsonb;
create unique index if not exists storage_objects_bucket_name_uk
  on storage.objects (bucket_id, name);
```

---

## What passed on this branch after merging main (11 September)

Listed so the next person knows what does not need re-checking:

- `db/checks/rebuild-from-migrations.sh`: 93 applied, 3 skipped by name (045,
  058, 065), 0 failed
- `db/checks/authorisation-tests.sh`: sections 2 to 4 pass; test 1 is open, as
  already recorded
- Typecheck, lint (0 warnings) and `next build` pass
- 12 of the 13 check scripts CI runs pass, including `test-proof-audit.ts` (52
  cases)
- `coles-parser-check.ts` fails on Node 22.23.1 with the exceljs
  streaming-reader error that `CLAUDE.md` already records as pre-existing.
  `lib/feeds/coles.ts` is untouched on this branch.
- All 28 routes return 200 on the seeded database, with no console errors on the
  screens that were driven in a browser
