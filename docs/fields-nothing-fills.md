# Fields the schema declares and nothing fills

**Measured on production, 14 September 2026**, with
`what-did-we-declare-and-never-fill.sh` in the build folder. 151 nullable
columns examined across every table in `public`.

This file exists so the next person does not investigate it a third time. Each
row below has a verdict and the reasoning behind it. **Nothing here is a bug
report** — most of these are fine, and saying which are fine is the point.

---

## Why it was looked for at all

Four times this build has found the same shape by accident, late, while
looking for something else:

- The driver licence photograph went to `localStorage` and nowhere else. A
  grep for "licence" across every server action returned nothing. Migration
  095, 11 September.
- `deliveries.driver_id` referenced `app_users`, the legacy staff directory,
  while every login and every RLS policy use `public.users`. Unusable since
  migration 001. Migration 098, 14 September.
- The mail app's "App RBAC scope restricting it to `accounts@`" existed in a
  code comment and had never been created in the tenant. 10 September.
- `deliveries.store_sig_name` appears in `001_init.sql` and nowhere else. The
  store signs, the image is kept, and who signed is never recorded. 14
  September, which prompted the sweep.

A field that exists, looks right on the screen, and is never filled does not
announce itself. Looking on purpose is cheaper than being surprised.

---

## What the method can and cannot see

It counts non-nulls per column, then greps `apps/web` and `services/` — the
code that runs in production — for anything that mentions the empty ones.

**Two blind spots, both found while using it, both worth knowing:**

**It searched only `apps/web` on the first run.** The forecasting engine lives
in `services/forecast/app.py` and writes `replenishment_plans` and
`engine_runs`, so every column those tables own would have been reported dead
on the strength of the web app not mentioning them. Fixed. Re-checked
afterwards and every verdict held, which was luck rather than method.

**It does not search `db/`, so a column written only by a SQL function
defined in a migration looks unreferenced.** `engine_runs.scenario` is the
worked example — migration 089 sets it on every run. Before dropping
anything, run:

```
grep -n "<column>" db/migrations/*.sql | grep -v "create table"
```

A hit inside a `create function` or `create procedure` means the column is
**unset**, not dead. Different problem, different fix. Every column below has
been through that check.

---

## Empty, and nothing in production code fills them

| table | column | rows | verdict |
|---|---|---|---|
| `deliveries` | `store_sig_name` | 801 | **Open question for Simona.** See below. |
| `replenishment_plans` | `final_qty` | 32,486 | **Deliberate. Leave it or drop it, do not build it.** See below. |
| `app_users` | `auth_user_id` | 5 | Vestigial. The intended bridge from the legacy staff directory to Supabase Auth. Never filled, and migration 098 routed around it on 14 September by repointing `deliveries.driver_id` at `public.users`. That 098 had to do that is the evidence this was never going to work. |
| `app_users` | `pin_hash` | 5 | Vestigial. A PIN login that was never built. Worth noting it is a security-shaped column that nothing compares against — if anything ever starts reading it, an all-null column must not mean "any PIN matches". |
| `products` | `other_code` | 116 | Vestigial. Added by migration 003 as a legacy import field; nothing ever wrote it. |
| `stores` | `pricing_tier_id` | 349 | Vestigial. Pricing tiers were never implemented. Appears in `db/supabase-seed.sql`'s column list, which does not run in production. |
| `jb_events_backup_056` | `product_ids` | 7 | **Not a finding.** A snapshot table taken by migration 056. It copied `events.product_ids`, which was null at the time. |
| `jb_store_backup_048` | `shelf_min` | 5 | **Not a finding.** Snapshot taken by migration 048, same reason. |

`feed_uploads.uploaded_by` was on this list until 14 September and is now
written — see the commit *"80 uploads and nobody signed for them"*.

---

## `replenishment_plans.final_qty` — deliberate, not missing

32,486 rows, null in every one, sitting beside `recommended_qty NOT NULL`.
The shape reads as *engine recommends → a human adjusts → `final_qty` is what
ships*, and the adjust step does not exist anywhere.

**It should not be built.** Traced on 14 September:

- `services/forecast/app.py` writes `replenishment_plans` as an **audit
  record** — its own header says "recommendation + reasoning". `store_reco`,
  which the app and the packing sheets read, is derived from it by SQL
  functions in migrations 088 and 089.
- There is no human override on the forecast side at all. `override_qty`
  exists, but on `store_product_days` for **invoice customers' standing
  orders** — a different thing entirely.
- That absence is the design. The Planning Brief records Simona calling the
  legacy system's percentage levers *"guessing games"* — *"what's 4% on two
  bagels?"* — and the decision was to **replace the cause, not re-skin the
  levers**. Adjustment happens through the events system (migrations 036, 056,
  063), which tells the engine about a school fete rather than asking a person
  to guess a number.

So `final_qty` is a leftover from the schema as first drafted, before that
decision. Building it would re-introduce the exact thing the brief set out to
remove. **Leave it, or drop it. Do not fill it.**

---

## `deliveries.store_sig_name` — a question, not a task

The store signs on a finger-drawn canvas. `saveDeliveryProof` takes no name
and there is no text field anywhere in the driver app, so filling this means
adding a *"who received it?"* input to a flow six people use at 4am that has
been deliberately built for speed.

The proof chain already carries the signature image, a timestamp, GPS and the
driver's identity (`driver_sig_name`, written on every drop since migration
098). A typed name strengthens it; the question is whether it is worth the
friction.

**That is Simona's call, not ours,** because it depends on something only she
knows: whether a driver can reliably get a name at a loading dock at all. Ask
her. If the answer is no, drop the column — a field that implies the system
records something it does not is worse than no field.

---

## Empty, but production code does mention them

Not bugs on their own. A feature that has not run yet looks exactly like this.
The ones worth a second look:

| table | column | why it is empty |
|---|---|---|
| `engine_runs` | `scenario` | **Not a defect.** Migration 089 sets it from `app_settings` where `key = 'service_level'`. Null across all 29 runs means **nobody has ever set the service-level dial** — the UI exists in `SettingsPanel.tsx` and writes that key. So every engine run to date has used the default `z` from `jb_engine_z()`. Worth raising at handover: the dial is there, it has never been touched, and nobody has checked whether the default is the right setting for this bakery. |
| `deliveries` | `driver_id`, `run_id` | Expected. Migration 098 taught the app to write both on 14 September, and all 801 existing rows predate it — 799 were seeded in one go on 24 August. |
| `store_settings` | `shelf_cap`, `photo_url`, `last_visit_on` | Expected. `store_settings` holds **per-store overrides** and has one row for 349 stores. `shelfcap.ts` falls back to `stores.shelf_max`, which is populated, so shelf capping works. An empty override table is what "nobody has overridden anything" looks like. |
| `products` | `launched_at` | Cold-start logic for new products. Nothing has launched since the system went in. |
| `stores` | `postcode` | **Was** empty across all 349 while `lib/queries.ts` read it on every store page. Migration 102, 14 September, backfilled 302 of them from `stores.address`. Twelve have a suburb and no postcode and are deliberately left null — several Sydney suburbs span more than one, and a wrong postcode on a delivery address is worse than an empty one. |

`deliveries.note`, `events.store_id` and `feed_uploads.error` also appear
empty-but-mentioned. All three are ordinary English words that match half the
codebase, so the mention count says nothing about them. That is a known limit
of the method, not a finding.

---

## What not to conclude from any of this

A column being empty proves nothing on its own. 799 of the 801 deliveries
were seeded in one go on 24 August and the driver app has been used twice, so
a great deal here is empty for reasons that are nobody's fault. The grep is
what separates *not yet* from *never*, and the two SQL checks above are what
separate *never* from *not by this code*.
