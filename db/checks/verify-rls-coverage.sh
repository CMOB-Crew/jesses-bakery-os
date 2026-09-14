#!/usr/bin/env bash
# Fails (exit 1) if any public base table does not BOTH enable and force
# row-level security.
#
# It used to check only that RLS was enabled. Policies do not apply to a
# table's owner unless FORCE is also set, so a table could report as covered
# and still be wide open to anything connecting as its owner. public.users was
# in exactly that state for three weeks with this check green. Migration 103.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${DATABASE_URL:-}" ]; then
  rows="$(psql "$DATABASE_URL" -Atqf "$here/rls-coverage.sql")"
else
  rows="$(psql -Atqf "$here/rls-coverage.sql")"
fi
if [ -n "$rows" ]; then
  echo "RLS coverage check FAILED -- these public tables are not fully covered:"
  echo "$rows" | sed 's/^/   - /'
  echo
  echo "Enabling RLS is half the job. Without FORCE, the three policies on a"
  echo "table are ignored for anything connecting as that table's owner."
  exit 1
fi
echo "RLS coverage check passed -- every public base table enables AND forces RLS."
