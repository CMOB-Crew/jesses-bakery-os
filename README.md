# Jesse's Bakery Operating System

Waste, forecasting and distribution for a handmade bakery supplying supermarkets
on pay-on-scan, where every unsold loaf is waste. It replaces the legacy Azure
spreadsheet system.

**This is a live production system.** It runs at `app.jessesbakery.com.au`
against a hosted Supabase project, with authentication enforced and row-level
security applied to every request. It is not a prototype and there is no demo
mode running in front of it.

Stack: **Postgres (Supabase) + Next.js 16 + a Python forecasting service**,
deployed on Netlify.

---

## Read this before you change anything

This section exists because the version of this file it replaces was written in
the first week of the build and then went untouched for a month. It told you to
apply two migrations, said the app ran against a local 84-store seed, and
described going live on Supabase as future work. All of that stopped being true
and nobody noticed, because a README is the one file no test covers.

So: **the numbers below were measured on 10 September 2026, not remembered.**
Where something is uncertain it says so. If you find a claim here that is no
longer true, that is a defect — fix it in the same commit as whatever made it
untrue.

| | |
|---|---|
| Migrations | 94 files. 91 apply to an empty Postgres, 3 are skipped by name with a stated reason. |
| Schema | 48 tables, 14 views. RLS enabled on every public base table. |
| Network | 273 active stores; 218 of them report scan sales. |
| Auth | `AUTH_ENFORCED` is **on**. A signed-out request to any non-public path is redirected to `/login`. |
| Database role | The app connects as `jbo_app`, which does **not** bypass RLS. |

`db/checks/rebuild-from-migrations.sh` is what keeps the first two rows honest —
it drops the schema and applies every migration in order, and CI runs it on every
push. If it fails, this repository can no longer rebuild the database it
describes.

---

## What's in the box

```
jesses-bakery-os/
├── apps/web/            Next.js 16 (App Router, TS) — the whole application
│   ├── app/             Overview, Stores, Packing, Driver, Feeds, Launches…
│   │   └── api/         machine-called endpoints (feed pulls, proof audit)
│   ├── components/      the screens
│   ├── lib/             db.ts (Postgres + runAsUser), queries.ts (typed reads)
│   └── scripts/         the checks CI runs — see "What CI actually proves"
├── db/
│   ├── migrations/      001…094, applied in numeric order
│   ├── checks/          rebuild-from-migrations.sh, authorisation-tests.sh
│   └── seed/seed.py     local fixture data only. NOT what production holds.
└── services/forecast/   FastAPI newsvendor / critical-fractile engine
```

---

## Three things that will mislead you

**1. `on_hand_ledger` is not the heart of the system today.** It was designed to
be, and the older version of this file said so. In practice nothing writes it —
the rows in production are the legacy load and stop at 22 August 2026 — and
migration 037 gates the engine's use of it behind
`app_settings.use_on_hand = {"enabled": false}` because the ledger did not
reconcile. Migration 093 makes the screens say "not counted" rather than
"nothing ran out". Do not switch it on without reading 037 and 093.

**2. A missing row and a zero are different, and the codebase is opinionated
about it.** Several columns carry a deliberate NULL meaning "we cannot see this":
`v_store_week.waste_pct` where `has_sales_feed` is false, and
`v_store_week.stockout_days` where `has_on_hand` is false. Reading either as
zero produces a confident false statement on a screen. `lib/store-scoring.ts` is
the single rule for whether a store can be scored at all, and
`scripts/test-store-scoring.mjs` scans the source to stop a sixth copy of that
rule appearing.

**3. `app_users` is the legacy identity table and is not the one in use.**
Application identity is `public.users`, keyed on `auth.uid()`, and
`public.current_app_role()` is what every policy reads. `app_users` survives
because older columns still reference it.

---

## Run it locally

Prereqs: Postgres 16, Node 22 (see `.nvmrc`), Python 3.11+.

```bash
# 1. Database — every migration, in order, not just the first two.
createdb jesses
DATABASE_URL=postgres://localhost/jesses bash db/checks/rebuild-from-migrations.sh
pip install "psycopg[binary]"
DATABASE_URL=postgres://localhost/jesses python db/seed/seed.py

# 2. Forecasting service
cd services/forecast && pip install -r requirements.txt
DATABASE_URL=postgres://localhost/jesses uvicorn app:app --port 8088
curl -X POST localhost:8088/plan        # writes replenishment_plans

# 3. Web app
cd apps/web && npm install
npm run build && npm run start          # http://localhost:3000
```

`rebuild-from-migrations.sh` **drops and recreates the schema** and refuses to
run against anything that looks like Supabase. Point it at a throwaway.

---

## What CI actually proves

Not "the tests pass" — these are the specific claims each check defends, and
most exist because the thing they check was once wrong in production.

| Check | What it stops |
|---|---|
| `rebuild-from-migrations.sh` | the repository silently losing the ability to rebuild the database |
| `authorisation-tests.sh` | a driver writing where they should not, **and** a driver being unable to write where they must |
| `test-store-scoring.mjs` | an unmeasured store reading "On track" — including a source scan for the superseded rule |
| `test-proof-audit.ts` | the proof-of-delivery audit going green over data it cannot see |
| `proxy-matcher-check.ts` | widening the auth-proxy exclusion and quietly unauthenticating the site |
| `workflows-keep-secrets…-check.ts` | a secret reaching a shell command or a URL, in a public repo |
| `dates-name-their-timezone-check.ts` | a date rendered without saying which clock it is on |

The authorisation suite reports one condition as an **open design gap** rather
than passing it: there is no driver-to-run assignment anywhere in the system, so
no policy can express "another driver's run". That is stated in its output, not
quietly counted as done.

---

## What runs on a schedule

| When | What |
|---|---|
| Weekday mornings | mailbox poller pulls the Coles and Woolworths reports out of the inbox |
| Weekday mornings | Harris Farm vendor-sales pull — **fails until its credentials are set in Netlify**, on purpose |
| Mondays 06:10 UTC | proof-of-delivery audit: every recorded proof still present, a rotating sample re-hashed |

All three are GitHub Actions that `curl` an endpoint guarded by
`FEED_POLL_SECRET`. **No workflow holds a Supabase credential**, and a CI check
refuses any that tries.

---

## Design system

The warm-premium identity (Fraunces + Inter, exception-first layout, paper
grain, status = colour + icon + label) lives as CSS custom properties in
`apps/web/app/globals.css`. Change a token there and it flows through every
screen. Status is never colour alone — always colour, icon and label.

---

## The forecasting engine

`services/forecast` implements a newsvendor order-up-to policy. On pay-on-scan an
unsold unit is ~100% waste while a stockout costs only the margin, so the optimal
stocking point is the **critical ratio** `Cu / (Cu + Co)` of the demand
distribution — deliberately below the mean. Every recommendation is capped at
`shelf_max` (the "139 loaves into a 45-capacity store" fix) and written with its
reasoning so the dashboard can explain *why 25, not 45*.

Honest tuning list: demand is the observed (censored) sold quantity, so a
sold-out line teaches the engine to send less next time — the fix is a
censored-demand estimator, and two guard rails in the `store_reco` layer hold the
line meanwhile. Coverage uses lead time and can be tuned per product. On-hand
netting is off, per the note above.

---

## Status

The operator dashboard, packing, driver, feeds, launches and invoicing screens
are built and live. Feed ingestion runs itself for two of three retailers.

Known gaps, all written down rather than discovered: the factory model was never
started; the driver app has no offline support; there is no route optimisation;
the assistant is keyword-routed rather than a language model; the Xero push is
built and switched off; and the image bytes behind proof of delivery are in no
backup — the record of each proof is, the photographs are not.
