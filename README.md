# Jesse's Bakery Operating System

The real build — a live, running application, not a prototype. Waste,
forecasting and distribution for a handmade bakery supplying 300+ (soon 600+)
Coles / Woolworths / Harris Farm stores on pay-on-scan, where every unsold loaf
is waste.

This repo replaces the legacy Azure spreadsheet system. It is built on the
recommended stack: **Postgres (Supabase) + Next.js + a Python forecasting
service**. Everything here runs today against a local Postgres seeded with a
realistic 84-store Sydney network; pointing it at the hosted Supabase project is
a connection-string change, nothing more.

## What's in the box

```
jesses-bakery-os/
├── apps/web/            Next.js 16 (App Router, TS) — the operator dashboard
│   ├── app/             Overview, Stores, region + store drill-downs
│   ├── components/      Sidebar, WasteChart (curve + hover), RecCard, StatusTag…
│   └── lib/             db.ts (Postgres client) + queries.ts (typed reads)
├── db/
│   ├── migrations/      001_init.sql (22 tables) · 002_views.sql (reporting)
│   └── seed/seed.py     deterministic FIFO shelf-life simulation → realistic data
└── services/forecast/   FastAPI newsvendor / critical-fractile engine
```

The heart of the system is the **on-hand ledger** (what the legacy system never
had) and **replenishment_plans** (the engine's auditable output). Retailers only
report what *sold* — waste is inferred from the ledger, never reported.

## Design system

The warm-premium identity (Fraunces + Inter, exception-first layout, paper
grain, status = colour + icon + label) lives as CSS custom properties in
`apps/web/app/globals.css`. Change a token there and it flows through every
screen — deliberately evolvable, not frozen.

## Run it locally

Prereqs: Postgres 16, Node 20+, Python 3.11+.

```bash
# 1. Database
createdb jesses
psql jesses -f db/migrations/001_init.sql
psql jesses -f db/migrations/002_views.sql
pip install "psycopg[binary]"
DATABASE_URL=postgres://localhost/jesses python db/seed/seed.py

# 2. Forecasting service
cd services/forecast && pip install -r requirements.txt
DATABASE_URL=postgres://localhost/jesses uvicorn app:app --port 8088
curl -X POST localhost:8088/plan        # writes replenishment_plans

# 3. Web app
cd apps/web && npm install
cp .env.local.example .env.local        # set DATABASE_URL
npm run build && npm run start          # http://localhost:3000
```

## Going live on Supabase

1. Create the Supabase project; run `001_init.sql` then `002_views.sql` in the
   SQL editor (add `003_postgis.sql` later for route optimisation).
2. Set `DATABASE_URL` (pooled connection string) in `apps/web/.env.local` and in
   the forecast service environment.
3. Replace the seed with the real ingestion: the three retailer feeds land in
   `sales_daily`, Xero customers map via `stores.xero_contact_id`, store IDs are
   `STO###` in `stores.retailer_store_id`.
4. Wire `app_users.auth_user_id` to Supabase auth and enable RLS policies.

## The forecasting engine

`services/forecast` implements a newsvendor order-up-to policy. On pay-on-scan an
unsold unit is ~100% waste while a stockout costs only the margin, so the optimal
stocking point is the **critical ratio** `Cu / (Cu + Co)` of the demand
distribution — deliberately below the mean. Every recommendation is capped hard
at `shelf_max` (the "139 loaves into a 45-capacity store" fix) and written with
its reasoning so the dashboard and assistant can explain *why 25, not 45*.

Known tuning items (honest list, not hidden): demand is currently the observed
(censored) sold quantity — the roadmap swaps in a censored-demand estimator using
the ledger's stockout flags; coverage uses lead time and can be tuned per product;
on-hand should later net out imminent-expiry stock.

## Status

Phase 0/1 foundation is running: schema, ledger, reporting views, the operator
dashboard (Overview + drill-downs, all live), and the forecasting engine. Next:
the driver/packing PWAs (design already locked in the prototypes), live feed
ingestion, and the deterministic NL assistant.
