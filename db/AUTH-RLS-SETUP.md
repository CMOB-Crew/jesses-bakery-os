# Auth + RLS foundation — setup & apply order

Connection model: **Option A** (Fred, confirmed 19 Aug 2026). Keep the raw
`postgres.js` SQL layer; inject the verified user's JWT claims per request
(transaction-local). No query rewrite.

The app can't reach the DB from the build sandbox — **run every SQL step below in
the Supabase SQL editor**, in order. Nothing here changes the live app until the
final flag flip, so it's safe to stage over a few sessions.

## Order of operations

1. **Migration `012_auth_identity.sql`** — identity + roles table (`public.users`
   keyed on `auth.uid()`), security-definer role helpers, signup trigger,
   default-deny. Safe now: adds one table + helpers, touches nothing existing.

2. **Enable Supabase Auth providers** (Dashboard → Authentication → Providers):
   - Email/password: on.
   - Microsoft (Azure): on. Client lives in **Jesse's Entra tenant** (reuse the
     legacy app registration `eacd20d9-…` or stand up a fresh single-tenant one
     alongside — it must be revocable by Jesse's admin after handover).

3. **Bootstrap the first admin** — after that person signs in once (they land
   with `role = null`, no access), promote them a single time:
   ```sql
   update public.users set role = 'admin' where email = '<first-admin-email>';
   ```

4. **Migration `013_view_security_invoker.sql`** — flips every `v_*` view to
   `security_invoker = on` so base-table RLS actually fires through the views.
   Safe on its own (no effect until 014).

5. **Create the app DB role** the site connects as — **it must NOT own the
   tables** (owners bypass RLS), and must not be superuser:
   ```sql
   create role jbo_app login password '<strong-password>' noinherit;
   grant usage on schema public to jbo_app;
   grant select, insert, update, delete on all tables in schema public to jbo_app;
   grant usage, select on all sequences in schema public to jbo_app;
   alter default privileges in schema public
     grant select, insert, update, delete on tables to jbo_app;
   ```
   Then point `DATABASE_URL` (Netlify env, all scopes) at this role's pooled
   connection string — not the `postgres` superuser.

6. **Create the engine writer role** — the forecasting engine writes
   `store_reco` / `replenishment_plans` under its own role, outside the
   per-request user policies:
   ```sql
   create role jbo_engine login password '<strong-password>' bypassrls;
   grant usage on schema public to jbo_engine;
   grant select, insert, update on replenishment_plans to jbo_engine;
   ```
   (`bypassrls` is why 014 doesn't need an engine policy. Give the engine its own
   connection string; don't reuse `jbo_app`.)

7. **Wire + deploy the login flow** (next build step) and set the env:
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY` — used by `lib/auth.ts` to verify tokens.
   - Leave `AUTH_ENFORCED` **unset** until step 9.

8. **Two-user test** (before enforcing) — sign in as two users, run the same
   query, confirm different rows; confirm an unauthenticated call returns nothing.

9. **Migration `014_rls_business_tables.sql`** — enables deny-by-default RLS on
   every business table. **Apply LAST**, and only once the wrapper is live and the
   test passes. Then set `AUTH_ENFORCED=1` on the live site.

## Keep the demo open

The demo build (`NEXT_PUBLIC_DEMO=1`, jessesbackerydemo.netlify.app) must **not**
set `AUTH_ENFORCED` and should keep using the current read connection — Simona
walks through it with no login wall. Auth/RLS enforcement is a **live-site-only**
flip; the demo stays open by design.

## The four things Option A must get right (Fred)

1. Claims are **transaction-local**: `set_config('request.jwt.claims', …, true)`.
   Session-level leaks the previous user onto the next pooled request.
2. The app role **does not own** the tables (or `force row level security` — 014
   does both).
3. **Verify the JWT before injecting** claims, server-side, every request
   (`lib/auth.ts`).
4. **One enforced wrapper** (`lib/db.ts` → `runAsUser`). Any query that skips it
   runs with no claims → RLS returns nothing (fails closed).
   Plus: **views run as invoker** (013), or policies never fire.
