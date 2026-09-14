# The fifteen conditions, and where each one stands

**As at 14 September 2026.**

`stack-decision-record.md` in this folder is Fred's document. It sets fifteen
conditions the build has to meet. It is reproduced here **unedited** — it is a
record of a decision, not a status board, and rewriting it to match what we
managed would destroy the only thing it is good for.

This file is the status board. It is ours, it is dated, and every row says how
the claim was arrived at.

## Why this file exists

The 8 September assessment counted three of fifteen conditions unmet. On
11 September a fourth turned out to be unmet as well, and when all fifteen were
finally walked end to end, **four had never been assessed at all** — 2, 7, 8 and
12. They were not judged met; nobody had looked.

The failure was not carelessness. It was that a condition would be written down,
quoted forward, and become established without anyone opening the thing it
described. Condition 1 was marked met on the strength of eighty-six policies
existing, which is a different question — a table with no row-level security has
no policies either, and counting policies cannot see it.

So this file separates **checked today** from **carried forward**, in every row.
A row marked *carried* is a claim inherited from the 11 September audit and not
re-verified since. Treat it as a lead, not a fact.

## Where they stand

| # | Condition | State | How, and when |
|---|---|---|---|
| 1 | RLS deny-by-default on every table | **met** | **Checked 14 Sept** on the live database: 50 tables in `public`, 50 with RLS enabled, 90 policies, no table uncovered. This is the first time it was asked as one query. |
| 2 | Assistant on a dedicated read-only role | **partly** | **Changed 14 Sept.** Every assistant query now runs inside a `read only` transaction, so it cannot write to anything whatever role the connection uses — Postgres refuses the write by transaction mode, not by permission. Asserted structurally and against a real database in `scripts/assistant-is-read-only-check.ts`. The dedicated `jbo_assistant` role is the remaining half and needs a password that must not live in this repo (condition 10): `docs/condition-2-the-assistant-role.md`, three steps. |
| 3 | Service-role key never in client code | met | Carried from 11 Sept. |
| 4 | Supabase Pro, `ap-southeast-2`, org Jesse owns | **partly** | Carried from 11 Sept. Pro: yes, since 1 September. No auto-pausing: yes. Region: **`ap-southeast-1`, Singapore, not Sydney.** Organisation: **CMOB's, with no bakery member.** The last two need a decision, not a build. |
| 5 | New accounts default to no role | met | Carried from 11 Sept. |
| 6 | Session tokens in cookies, never localStorage | met | Carried from 11 Sept. |
| 7 | Rate limiting on login and reset | **not met** | Carried from 11 Sept. Nothing in the codebase implements it. Supabase Auth applies its own limits and those are real, but they are not this condition: not five per minute, not per identifier, and nothing logged where we can read it. |
| 8 | ~300KB WebP compression, storage lifecycle policy | **partly** | Carried from 11 Sept. Compression works and beats the target — 56 kB an object, measured 10 September. The format is JPEG, not WebP, which is arguable. **The lifecycle policy is not arguable: nothing purges anything.** Migration 095 writes a driver licence photograph per driver per working day, indefinitely. |
| 9 | PITR plus an independent weekly dump | **not met** | **Checked 14 Sept.** Point-in-time recovery is an unpurchased add-on; the project has seven daily backups and nothing finer. Supabase's own backups page states storage objects are not included — so **the delivery photographs have no backup of any kind.** The weekly-dump signer shipped (`4543450`); the sync, route, schedule and bucket did not. |
| 10 | No credentials in source. Secret scanning in CI | **met** | **Closed 14 Sept.** Scanning was already met (gitleaks over full history). The other half was not: the production superuser connection string sat in three `legacy-load` scripts, with **127 more scripts reading it out of one of them at runtime**. All 130 now read `~/.jbo/production.env`, mode 600, outside the build folder and outside this repository. Verified afterwards: no file in the build folder holds a database password. **The credential itself has not been rotated.** |
| 11 | Ingestion fails loudly and alerts | met | Carried from 11 Sept. |
| 12 | Delivery carries driver, run validation, duplicate detection | **met** | **Closed 14 Sept**, migration 098 and commit `941b13c`. See below. |
| 13 | Server-verified timestamps retained | met | Carried from 11 Sept. |
| 14 | Lead times and configuration are data, not code | met | Carried from 11 Sept. |
| 15 | Three authorisation tests in CI | met | Carried from 11 Sept. `ci.yml` runs them by name. |

**Ten met. Two not met (7, 9). Three partly met (2, 4, 8).**

On 11 September it was seven met, four not met, three partly and one unverified.

## Condition 12, because "met" needs a qualification

`deliveries.run_id` and `deliveries.driver_id` have existed since migration 001
and nothing ever wrote either. The reason was not neglect. `driver_id`
referenced `app_users(id)` — the legacy staff directory — while the application,
the provisioning script and every RLS policy use `public.users(id)`, keyed on
`auth.uid()`. Two identity systems. The column was **unusable, not forgotten**,
and migration 082 said so in August.

Migration 098 repoints the key at `public.users(id)` with `ON DELETE SET NULL`,
so removing a person can never remove the record of a delivery, and indexes both
columns. `driver-proof-actions.ts` now writes both on every drop, with the run
**validated** server-side: the phone says which run the driver is doing, and the
server checks the store really is on that run for that weekday —
`store_run_overrides` for the day if there is one, otherwise
`stores.default_run_id`. A mismatch writes NULL and still records the delivery,
because a silently wrong run would be read as fact by the packing sheet.
Duplicate detection was already met by migration 080's unique key.

**The qualification.** The mechanism is met; the column is still empty. Nothing
was backfilled, deliberately — inventing a driver for a delivery that already
happened would be worse than the gap. The first row to carry a driver and a run
will be the next drop a driver records. As at 14 September, 801 delivery rows
exist and none carries either value.

## What is left, in the order worth doing it

1. **Condition 2** — one Postgres role with `SELECT` only, one connection
   string, one import changed. Small now. It stops being small the day anyone
   upgrades the assistant from keyword routing to generating SQL, because the
   blast radius is already wired in.
2. **Condition 8's lifecycle policy** — government ID photographs are
   accumulating today, with nothing to purge them.
3. **Condition 9** — the delivery photographs are in no backup at all. That is a
   storage decision, not a PITR decision, and PITR would not have fixed it.
4. **Conditions 4 and 7** — each needs a decision rather than a build. Region and
   ownership sit with Tommy and Jesse. Rate limiting is a scope call.
5. **Rotate the production password.** Not one of the fifteen, and the largest
   remaining credential risk.
