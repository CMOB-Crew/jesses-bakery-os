#!/usr/bin/env bash
# Fails (exit 1) if any public base table is missing row-level security.
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
  exit 1
fi
echo "RLS coverage check passed -- every public base table has RLS enabled."
