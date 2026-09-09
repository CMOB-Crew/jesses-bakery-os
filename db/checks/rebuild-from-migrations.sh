#!/usr/bin/env bash
#
# rebuild-from-migrations.sh -- can this repository stand the database up?
#
# On 10 September the answer was no, and nobody had ever asked. Applying all 89
# migrations in order to an empty Postgres 16 got 78 of them in. Four failed on
# columns that exist in production and are created by nothing here, because
# migrations 003 and 004 were written, applied, and never committed.
#
# That is the handover question underneath it: Jesse's system exists as a
# running database. If it were lost, what we hand him has to be able to rebuild
# it. This script is how that stops being an assumption.
#
# Usage:
#   DATABASE_URL=postgres://... db/checks/rebuild-from-migrations.sh
#
# The database is DROPPED AND RECREATED. Point it at a throwaway and nothing
# else -- it refuses anything that looks like production.
#
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
mig="$here/../migrations"

: "${DATABASE_URL:?set DATABASE_URL to a THROWAWAY database}"
case "$DATABASE_URL" in
  *supabase.co*|*supabase.com*|*pooler.supabase*)
    echo "REFUSING: DATABASE_URL points at Supabase. This script drops schemas."
    exit 1 ;;
esac

# ---------------------------------------------------------------------------
# Migrations that cannot run against a plain Postgres, and why. Each one is a
# real dependency on something only Supabase supplies, NOT a broken migration.
# Anything not on this list is expected to apply, and a failure is a defect.
# ---------------------------------------------------------------------------
skip_reason() {
  case "$1" in
    045_*) echo "refuses to run without the real pg_cron extension, by design" ;;
    058_*) echo "inserts an events row without kind, which is not null -- fails on an empty database, skipped on production because the row already exists" ;;
    065_*) echo "needs jb_plan_before_064, which 064 creates by string-replacing a function read out of the LIVE database" ;;
    *)     echo "" ;;
  esac
}

echo "Resetting the schema…"
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 <<'EOSQL'
drop schema if exists public  cascade;
drop schema if exists auth    cascade;
drop schema if exists cron    cascade;
drop schema if exists storage cascade;
create schema public;
EOSQL

echo "Applying the CI stubs (auth, jbo_app, pg_cron, storage)…"
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$here/ci-auth-stub.sql"

applied=0; skipped=0; failed=0
echo
for f in $(ls "$mig" | sort); do
  reason="$(skip_reason "$f")"
  if [ -n "$reason" ]; then
    printf 'SKIP  %-58s %s\n' "$f" "$reason"
    skipped=$((skipped+1))
    continue
  fi
  if out="$(psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$mig/$f" 2>&1)"; then
    applied=$((applied+1))
  else
    failed=$((failed+1))
    printf 'FAIL  %s\n' "$f"
    printf '%s\n' "$out" | grep -m2 -E 'ERROR|DETAIL' | sed 's/^/        /'
  fi
done

echo
echo "applied $applied · skipped $skipped · failed $failed"

if [ "$failed" -ne 0 ]; then
  echo
  echo "The repository cannot rebuild the database. Every failure above is a"
  echo "migration that production has and this repository cannot reproduce."
  exit 1
fi

# A schema is not proof on its own. The one property worth asserting after a
# rebuild is the one the whole authorisation model rests on.
echo
DATABASE_URL="$DATABASE_URL" bash "$here/verify-rls-coverage.sh"

echo
echo "The database can be rebuilt from this repository."
