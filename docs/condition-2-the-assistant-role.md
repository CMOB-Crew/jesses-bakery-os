# Condition 2, the half that needs a password

**Status: the risk is closed. The role is not created yet.**

Condition 2 reads: *"The AI assistant runs on a dedicated read-only
Postgres role with RLS applied. Never the service role."*

As of 14 September 2026 every assistant query runs inside a **read only**
transaction. Postgres refuses any write in one — not by permission, by
transaction mode — so the assistant cannot write to anything regardless of
which role its connection uses. That shipped, needs no credential, and is
asserted in `scripts/assistant-is-read-only-check.ts`.

What is left is the dedicated role itself, which needs a password that must
not exist in this repository (condition 10). Three steps, ten minutes.

---

## 1. Create the role

Run against production with the same connection the `apply-NNN-production`
scripts use. It creates nothing that can log in yet — the password is set
in step 2, in Supabase, not here.

```sql
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'jbo_assistant') then
    create role jbo_assistant login;
  end if;
end $$;

-- Read, and nothing else. Explicit rather than inherited.
revoke all on schema public from jbo_assistant;
grant usage on schema public to jbo_assistant;
grant select on all tables in schema public to jbo_assistant;
alter default privileges in schema public
  grant select on tables to jbo_assistant;

-- RLS must apply to it. This is the line that makes it different from the
-- service role, and the reason the condition says "never the service role".
alter role jbo_assistant
  nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
```

Verify in the same session:

```sql
select rolname, rolsuper, rolbypassrls, rolcanlogin
  from pg_roles where rolname = 'jbo_assistant';
-- expect: f, f, t

select count(*) filter (where privilege_type = 'SELECT') as can_read,
       count(*) filter (where privilege_type <> 'SELECT') as can_do_anything_else
  from information_schema.role_table_grants
 where grantee = 'jbo_assistant';
-- expect: can_do_anything_else = 0
```

## 2. Give it a password

Supabase dashboard → Project Settings → Database. Set a password for
`jbo_assistant`, or run `alter role jbo_assistant password '...'` from a
session whose history is not kept. It goes straight into step 3 and nowhere
else — not into this repo, not into Slack.

## 3. Set the environment variable

Netlify → Site configuration → Environment variables:

```
ASSISTANT_DATABASE_URL = postgres://jbo_assistant:<password>@<the same pooler host as DATABASE_URL>
```

Use the **pooler** host, the same one `DATABASE_URL` uses. `lib/db.ts`
picks it up on the next deploy with no code change: SSL and the
prepared-statement setting are derived from the host exactly as they are
for the main connection.

## 4. Confirm

```
npx tsx scripts/assistant-is-read-only-check.ts
```

The closing line says which of the two states the assistant is in. Once
`ASSISTANT_DATABASE_URL` is set it reads *"It is on its own role"*.

---

## Why the order is this way round

The read-only transaction is the half that closes the risk, and the role is
the half that satisfies the wording. Doing the role first would have looked
better on the conditions board and left the app one careless import away
from the read-write connection — the read-only transaction is what makes
that import harmless. Doing it in this order means the dangerous window was
minutes, not days.
