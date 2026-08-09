# Deploy Jesse's Bakery OS → a live link

The stack is Next.js (app) + Postgres (database). A live URL means hosting both.
Recommended: **Supabase** (database) + **Vercel** (app). ~10 minutes.

There are two ways to do it. Either gets you a real, always-on URL.

---

## Fast path — you click, I've made each step a paste

### 1. Database (Supabase) — ~4 min
1. Go to supabase.com → **New project** (free tier is fine). Pick a name and a
   database password; wait for it to finish provisioning.
2. Open **SQL Editor** → **New query**.
3. Paste the entire contents of **`db/supabase-setup.sql`** (schema + views +
   the whole seeded network in one file) and click **Run**. You should see
   `seeded | 84 | ... | 14.4` at the bottom.
4. Go to **Project Settings → Database → Connection string → URI**. Copy it and
   put your password in place of `[YOUR-PASSWORD]`. This is your `DATABASE_URL`.

### 2. App (Vercel) — ~4 min
1. Put this repo on GitHub (create a repo, push it) — or use the Vercel CLI from
   the `apps/web` folder: `npm i -g vercel && vercel`.
2. On vercel.com → **Add New → Project** → import the repo. Set the **Root
   Directory** to `apps/web`.
3. Under **Environment Variables** add:
   `DATABASE_URL` = the Supabase URI from step 1.4
4. **Deploy.** In ~2 minutes you get a `https://your-app.vercel.app` link.

That URL is the real app on the real database — fully interactive.

---

## Hands-off path — connect the connectors and I drive it

In claude.ai, connect the **Supabase** and **Vercel** connectors (Settings →
Connectors). Then tell me and I'll:
- create the Supabase project and run the setup SQL for you (the seed is small
  enough to send straight through), and
- walk the Vercel deploy the rest of the way.

(Heads up: the Vercel connector can *manage* deployments but can't push brand-new
code, so the app import in step 2 above still needs a couple of your clicks even
on this path. The database side I can fully automate.)

---

## Notes

- **The forecasting service** (`services/forecast`) isn't part of the web
  deploy. Its output (`replenishment_plans`) can be regenerated any time by
  running it against the same `DATABASE_URL`; for the live demo the dashboard
  reads everything else directly. Host it later on Render/Railway if you want the
  nightly engine running in the cloud.
- **SSL** is handled automatically — `apps/web/lib/db.ts` turns SSL on for any
  non-local database, which is what Supabase requires.
- **Going from demo to real data**: swap `db/supabase-setup.sql`'s seed for the
  real feeds (`sales_daily` from the three retailers, `stores.xero_contact_id`
  mapping, `STO###` ids). The schema doesn't change.
