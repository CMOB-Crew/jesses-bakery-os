-- CI ONLY -- do NOT run against any real database.
-- The migrations reference Supabase's auth schema (auth.users, auth.uid()).
-- In CI we apply them against a vanilla Postgres, so we stub the minimal auth
-- objects here first. On Supabase these already exist and this file is not used.
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
