#!/usr/bin/env bash
# Fails (exit 1) if any public base table is missing row-level security.
# Connection comes from standard PG* env vars (PGHOST/PGPORT/PGUSER/PGDATABASE/
# PGPASSWORD) or, if set, $DATABASE_URL. Read-only -- safe to run anywhere.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

if [ -n "${DATABASE_URL:-}" ]; then
  rows="$(psql "$DATABASE_URL" -Atqf "$here/rls-coverage.sql")"
else
  rows="$(psql -Atqf "$here/rls-coverage.sql")"
fi

if [ -n "$rows" ]; then
  echo "RLS coverage check FAILED -- these public tables have row-level security disabled:"
  echo "$rows" | sed 's/^/   - /'
  echo ""
  echo "Fix: enable RLS on each in the appropriate migration (014 or 018),"
  echo "or, if a table is deliberately exempt, add it to the allowlist in"
  echo "db/checks/rls-coverage.sql with a reason."
  exit 1
fi

echo "RLS coverage check passed -- every public base table has RLS enabled."
