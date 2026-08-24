# Set-based port of the forecasting engine

`app.py` is the reference implementation of the newsvendor policy (Fred's
handover, 18 Aug). It loops per store x product, firing two queries each — about
30,000 combinations and 60,000 round trips. That is fine against the local
database it was written for (`127.0.0.1:5433`); against Supabase in Singapore
from a laptop it takes hours.

These two files run the identical arithmetic server-side in one pass, in seconds.

| File | What it does |
|---|---|
| `plan_dryrun.sql` | Reports what the engine *would* recommend. Writes nothing. |
| `plan_write.sql`  | Same maths, writes to `replenishment_plans`. Transactional. |

Both take the target date as a psql variable:

```
psql "$DATABASE_URL" -v target=2026-08-27 -f plan_dryrun.sql
psql "$DATABASE_URL" -v target=2026-08-27 -f plan_write.sql
```

Run the dry run and read it before writing. Use the **privileged** connection on
**port 5432** (session pooler) — not `jbo_app`, and not 6543.

## The maths (unchanged from app.py)
- Weekday demand: mean and population std of `units_sold` for the target weekday,
  last 6 occurrences. A single observation gets `std = mean * 0.25`, as app.py does.
- `coverage = max(1, products.lead_time_days)`
- `forecast = mean * coverage * (1 + event uplift)`
- `target_stock = max(0, round(forecast + z * std * sqrt(coverage)))`
- `z = -0.19920132478926697` — the 0.4211 critical fractile of 0.40/(0.40+0.55).
  **Negative on purpose:** on pay-on-scan a wasted loaf costs the whole unit
  while a stockout costs only margin, so the optimum sits *below* the mean.
- `recommended = max(0, target_stock - on_hand)`, capped at `shelf_max`,
  floored at `min_on_shelf` when non-zero.

## One thing this adds that app.py does not
**Delivery-day scoping.** `app.py` plans every active store for every target
date. Jesse doesn't deliver everywhere daily — 144 stores Monday, 101 Thursday,
50 Sunday. Unscoped, the engine's sourdough came out at 5,246 units against
Jesse's real sheet of 2,566. Scoped via `stores.delivery_days` (migration 026)
it lands at 2,280 — 11% under his current bake, which is the trim the whole
system exists to make.

Validated 24 Aug against Jesse's own printed sourdough sheet (Thu 13 Aug):

| Line | Engine | Jesse | Diff |
|---|---|---|---|
| Sourdough White | 612 | 658 | −7% |
| Wholemeal | 445 | 480 | −7% |
| Spelt | 372 | 389 | −4% |
| Soy & Linseed | 355 | 374 | −5% |
| Rye | 295 | 289 | +2% |
| Dark Rye | 201 | 376 | **−47%** |

Dark rye is the outlier and is not yet explained — either the biggest
over-bake in the bakery, or a data fault. Worth resolving before anyone acts on it.

## Known gaps
- 12 of the 101 Thursday stores get no plan: no sales history for that weekday.
- `on_hand_ledger` is empty, so `on_hand` is 0 everywhere and `recommended`
  equals `target_stock`. The estimated-on-hand step — the one Fred called the
  thing the legacy system misses entirely — is not yet doing any work.
- Nothing yet connects `replenishment_plans` to `store_reco`, which is what the
  dashboard actually reads. Until that exists the dashboard cannot move off 8 Aug.
