# Jesse's Bakery — Stack & Architecture Decision

**Decision record v1.1.0 · 11 August 2026 · Fred**

*Amended 18 August 2026: authentication changed from custom JWT-minting to Supabase Auth on handover to Javonte. See Authentication below.*

---

## Decisions

1. **Platform.** Supabase (Postgres, row-level security, storage, realtime) in the Sydney region, with React PWAs for the browser applications. Not extending or patching the existing Azure system.
2. **Data.** Clone the data out of Azure SQL into a purpose-designed Postgres schema. Azure decommissioned after a parallel-run period.
3. **Authentication.** Supabase Auth. Email/username plus password, and Microsoft login, resolving to the same user record.
4. **Forecasting.** Deterministic code, layered. Language model used for the assistant and for explanation, never for generating quantities.

---

## Why not extend the existing stack

**The contracted scope does not exist in the current system.** Live editable delivery and production sheets, driver PWA, packing app, natural-language assistant, one-click store setup. None is reachable by extending an application whose Product Master and Final Delivery screens are locked and not editable by the client at all.

**Retrofitting authorisation costs more than starting clean.** A single 4,059-line file, roughly 60 endpoints, no tests, and no server-side authentication of any kind.

**It is not one stack, it is five.** Node application, Python Function Apps, Data Factory pipelines, SQL stored procedures, and a third-party automation service with direct database access.

**No version control on the parts that matter.** Nine copies of the forecasting procedure exist in the database. Data Factory is not git-connected. Database objects are edited in place.

**End-of-life platform, free-tier database.** The application runtime no longer receives security updates. The database sleeps when idle, has single-copy backups, and is capped below what 500 stores will require.

**Credentials require rotation regardless.** The database administrator password is in plain text in deployed source and in the code repository.

**The client already decided this.** Rebuild rather than layer on top was agreed on the first call.

---

## Platform

Supabase provides Postgres, row-level security, file storage and realtime in one managed service. On a compressed timeline that is roughly a week of work not spent hand-building separate subsystems.

Postgres suits the data: relational, a star schema for dashboard aggregates, and pgvector for the assistant's retrieval, all in one place.

No practical lock-in. It is Postgres, the project sits on an organisation Jesse owns, and exiting is a database dump.

**Hosting.** Frontends on Netlify. All server-side logic lives in Supabase rather than in Netlify functions: the nightly batch runs in-database via pg_cron, and privileged operations (Claude API, Xero, feed ingestion) run as Supabase Edge Functions in Sydney.

Netlify functions run in us-east-1 on the current plan, a poor fit for an entirely Australian user base, and a text-to-SQL round trip can exceed the 10-second synchronous limit. Running that work next to the database avoids both.

---

## Authentication

**Use Supabase Auth.** `auth.uid()` is available in policies natively, with no token signing to get wrong.

*This supersedes the v1.0.0 decision to build custom authentication issuing Supabase-compatible JWTs. That call was made on the basis of controlling the login layer directly. On handover, with a 3 September date, the lower-risk option is the managed one — hand-rolled authentication is precisely what failed in the system being replaced.*

**Sign-in methods.** Email or username plus password, and Microsoft login via a single-tenant Entra app registration so only company accounts can authenticate. Both resolve to the same user record, linked on verified email.

**Roles live in the database, not the token.** A `public.users` table keyed on `auth.uid()`, read by a `stable security definer` helper function that policies call. A role baked into a token stays valid until expiry; a role in the database can be revoked immediately, which matters for drivers and casual staff.

**Sessions.** Approximately three hours for office roles, matching the client's stated preference. Longer or refresh-backed for drivers so they do not re-authenticate mid-run.

**Default deny.** Accounts created via either method land with no role and no access until an administrator assigns one. Once tenant-restricted single sign-on is enabled, any company account can complete a login, so this default is load-bearing.

**Note for client conversations.** The system being replaced also used Microsoft login. It had no security because the token was only validated in the browser. What makes this secure is server-side validation plus row-level security, not the choice of identity provider.

---

## Data approach

Clone, not lift-and-shift. Take the data, not the schema.

**Migrate:** sales history, stores, products, standing orders, and the dated forecast snapshots.
**Do not migrate:** the table structure. Two parallel naming conventions, a production table with no history, and unresolved store renumbering. Design a proper star schema with real delivery history.

Volume is trivial. The entire database is under 1GB. The work is reconciliation, not movement.

**Sequencing**

- Phase 0: read directly from Azure SQL to produce the proof number. No dependency, no risk.
- Phase 1: load history into Postgres, rebuild ingestion to feed Postgres.
- Go-live: Postgres is the system of record. Azure runs read-only as fallback.
- After a clean reconciled month: decommission.

The fallback window is bounded externally: a security token in the wastage report configuration expires around 30 October 2026.

---

## Forecasting approach

1. **Replenishment loop** — order up to target, minus estimated on-hand, capped at shelf maximum, floored at minimum. Arithmetic, and the source of most of the waste reduction.
2. **Baseline forecast** — day-of-week seasonal average per store per product with trend adjustment.
3. **Safety buffer** — newsvendor model, sized from the relative cost of a stockout versus a wasted unit.
4. **Machine learning** — only if it beats layers 1 to 3 in a backtest.

Claude is used for the natural-language assistant and for explaining computed results. It does not generate quantities.

See `forecasting-engine-handover.md` for the full engine specification, including the legacy algorithm and the bugs not to reproduce.

---

## Conditions

1. Row-level security deny-by-default on every table, enabled before any data is loaded
2. The AI assistant runs on a dedicated read-only Postgres role with RLS applied. Never the service role
3. The service-role key never appears in client code
4. Supabase Pro, ap-southeast-2, on an organisation Jesse owns. No auto-pausing compute anywhere in the stack
5. New accounts default to no role and no access
6. Session tokens in HttpOnly, Secure, SameSite cookies. Never localStorage
7. Rate limiting on login and password reset, five attempts per minute per identifier, breaches logged
8. Client-side image compression before upload, target ~300KB WebP, with a storage lifecycle policy
9. Point-in-time recovery plus an independent weekly dump into storage Jesse controls
10. No credentials in source, ever. Secret scanning in CI
11. Ingestion fails loudly and alerts when a feed does not land
12. Delivery records carry driver identity, store and run validation, and duplicate detection per store per day
13. Server-verified timestamps retained
14. Lead times, shelf min/max and product configuration are data, not code
15. Three authorisation tests in CI: a driver cannot read another driver's run, a restricted role cannot write where it should not, and an unauthenticated request returns nothing from any table

---

## Risks accepted

**Migration reconciliation.** Two parallel table naming conventions and unresolved store renumbering must be untangled. Mitigated by a scripted, re-runnable migration and full reconciliation against the source before cutover. These problems exist whether we migrate or not.

**Ingestion rebuild is on the critical path.** Mitigated by Data Factory pipeline definitions being exportable, giving a complete specification of current behaviour.

**Team familiarity.** The team is stronger in JavaScript than Python, which is why forecasting layers 1 to 3 run in SQL and the application language rather than a Python service.

---

## Open items

- Identify what Make.com does before cutover. It has direct database access and may sit in the daily ingestion path
- Confirm which forecast procedure version is live and what invokes it
- Confirm whether any retailer feed requires a fixed source IP
- Confirm session length for the driver role with the client
- Coles feed stale from 3 August (Power BI format change); silent load failure
