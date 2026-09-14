#!/usr/bin/env bash
# =====================================================================
# what-did-we-declare-and-never-fill.sh — READ ONLY. Changes nothing.
#
# THE BUG THIS BUILD KEEPS FINDING, LOOKED FOR ON PURPOSE FOR ONCE.
#
# Four times now, the same shape: a field exists, the schema looks right,
# every screen reads fine, and NOTHING EVER PUTS ANYTHING IN IT.
#
#   * The driver licence photograph was written to localStorage and nowhere
#     else. A grep for "licence" across every server action returned nothing.
#     Migration 095, 11 September.
#   * deliveries.driver_id referenced app_users, the legacy staff directory,
#     while every login and every RLS policy use public.users. Unusable since
#     001. Migration 098, 14 September.
#   * The mail app's "App RBAC scope restricting it to accounts@" was written
#     in a code comment and never created in the tenant. 10 September.
#   * deliveries.store_sig_name appears in 001_init.sql and in NOTHING ELSE.
#     The store signs, we keep the image, and who signed is never recorded.
#     Found 14 September, which is what prompted this script.
#
# Each was found by accident, late, while looking for something else. This
# looks for the whole class at once.
#
# WHAT IT DOES
#
#   1. Counts non-nulls for every nullable column in every public table.
#   2. For every column that is empty in every row, greps the APPLICATION
#      code -- not the migrations -- to see whether anything mentions it.
#   3. Sorts the result into three piles that mean different things.
#
# THE THREE PILES, AND WHY THE DISTINCTION IS THE WHOLE POINT
#
#   DEAD      empty in production AND never mentioned in application code.
#             Nothing can ever fill it. Either a promise not kept or a field
#             that should be dropped, and both are worth knowing.
#
#   WAITING   empty in production but the code DOES write it. Not a bug: a
#             feature that has not run yet. driver_licences is the honest
#             example -- migration 095 landed 11 September and no shift has
#             started since.
#
#   (filled)  has at least one value. Not listed.
#
# A column being empty proves nothing on its own. 799 of the 801 deliveries
# were seeded in one go on 24 August, so plenty is empty for reasons that are
# nobody's fault. The grep is what separates "not yet" from "never".
#
# Every statement is a plain SELECT. No writes, no temp tables, nothing that
# outlives the connection -- safe on the transaction pooler.
#
#   bash -n "$HOME/Desktop/CMOB/01 Active Builds/Jesses Bakery System Build/what-did-we-declare-and-never-fill.sh"
#   bash    "$HOME/Desktop/CMOB/01 Active Builds/Jesses Bakery System Build/what-did-we-declare-and-never-fill.sh"
# =====================================================================
set -euo pipefail

BASE="$HOME/Desktop/CMOB/01 Active Builds/Jesses Bakery System Build"
REPO="$BASE/jesses-bakery-os"
SRC="$HOME/.jbo/production.env"

export PSQL_PAGER=cat
export PAGER=cat

if ! command -v psql >/dev/null 2>&1; then
  echo "FAIL  psql is not installed, or not on PATH."; exit 1
fi
if [ ! -f "$SRC" ]; then
  echo "FAIL  Cannot find $SRC, which is where the live connection string lives."
  exit 1
fi
if [ ! -d "$REPO/apps/web" ]; then
  echo "FAIL  Cannot find the repo at $REPO"; exit 1
fi

DBURL=""
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    PGURL=*) DBURL="${line#PGURL=}"; break ;;
  esac
done < "$SRC"
DBURL="${DBURL%\'}"; DBURL="${DBURL#\'}"
DBURL="${DBURL%\"}"; DBURL="${DBURL#\"}"

case "$DBURL" in
  *pooler.supabase.com*) : ;;
  *) echo "FAIL  Not the live pooler. Refusing."; exit 1 ;;
esac

echo "— connecting, read only —"
psql "$DBURL" -At -c "select '  ' || current_database() || ' as ' || current_user"

GEN="${TMPDIR:-/tmp}/jbdead.$$.gen.sql"
RUN="${TMPDIR:-/tmp}/jbdead.$$.run.sql"
OUT="${TMPDIR:-/tmp}/jbdead.$$.out"
trap 'rm -f "$GEN" "$RUN" "$OUT"' EXIT

# ---------------------------------------------------------------------
# Step 1: write the query that counts everything.
#
# Generated rather than hand-written because it has to cover every column of
# every table, and a hand-written list is out of date the next time somebody
# adds one -- which is the same class of staleness this whole script exists
# to find.
#
# Nullable columns only. A NOT NULL column cannot be empty, so it would only
# add noise. Tables with no rows are skipped by the report, not the query:
# an empty table's columns are empty for an obvious reason.
# ---------------------------------------------------------------------
# No \pset directives in here. They echo "Pager usage is off." to stdout,
# which lands in the generated file and makes it a syntax error. The same
# settings come from psql's -At flags on the line that runs it.
cat > "$GEN" <<'PGSQL'
select string_agg(
         format(
           'select %L::text as tbl, %L::text as col, count(%I)::bigint as filled, count(*)::bigint as rows from %I.%I',
           c.table_name, c.column_name, c.column_name, c.table_schema, c.table_name
         ),
         E'\nunion all\n' order by c.table_name, c.ordinal_position)
       || E'\norder by 1, 2;'
  from information_schema.columns c
  join information_schema.tables t
    on t.table_schema = c.table_schema and t.table_name = c.table_name
 where c.table_schema = 'public'
   and t.table_type = 'BASE TABLE'
   and c.is_nullable = 'YES';
PGSQL

psql "$DBURL" -v ON_ERROR_STOP=1 -At -f "$GEN" > "$RUN"

if [ ! -s "$RUN" ]; then
  echo "FAIL  Could not build the column list. Nothing has been changed."
  exit 1
fi

echo "— counting every nullable column in every table (one pass, may take a moment) —"
psql "$DBURL" -v ON_ERROR_STOP=1 -At -F '|' -f "$RUN" > "$OUT"

total=$(wc -l < "$OUT" | tr -d ' ')
echo "  $total nullable columns examined."
echo

# ---------------------------------------------------------------------
# Step 2: for every column that is empty in every row, ask the codebase.
#
# CODE THAT RUNS IN PRODUCTION, which is apps/web AND services/. A column
# always appears in the migration that created it, so counting db/ would mean
# nothing at all -- the question is whether anything ever puts a value in it.
#
# services/ is in that list because the first version of this script searched
# apps/web alone, and the forecasting engine lives in services/forecast/app.py
# and writes replenishment_plans and engine_runs. Every column those tables
# own would have been reported DEAD on the strength of the web app not
# mentioning them. It happened not to produce a wrong answer on the first run
# -- re-checked afterwards, all nine held -- which is the kind of luck worth
# removing rather than relying on.
#
# db/ is excluded entirely, seeds included. A seed file is not something that
# runs in production, so a column only a seed mentions is still a column
# nothing fills.
#
# The match is deliberately generous: any mention at all, anywhere in
# apps/web. A generous match makes a zero mean something. "Never mentioned in
# the application" is a fact; "never written" would be a guess dressed up as
# one, because a bash grep cannot tell a read from a write.
# ---------------------------------------------------------------------
echo "=== DEAD — empty in production, and the application never mentions it ==="
echo
printf '  %-26s %-26s %8s  %s\n' "TABLE" "COLUMN" "ROWS" "MENTIONS IN apps/web"
printf '  %-26s %-26s %8s  %s\n' "--------------------------" "--------------------------" "--------" "--------------------"

dead=0
waiting=0
waiting_list="${TMPDIR:-/tmp}/jbdead.$$.waiting"
: > "$waiting_list"

while IFS='|' read -r tbl col filled rows; do
  [ -z "${tbl:-}" ] && continue
  # A column in an empty table is empty for an obvious reason.
  [ "${rows:-0}" = "0" ] && continue
  [ "${filled:-0}" != "0" ] && continue

  # `|| true` is load-bearing, and its absence killed the first run of this
  # script at exactly the moment it found what it was looking for.
  #
  # grep exits 1 when it matches nothing. Under `set -o pipefail` that becomes
  # the pipeline's status even though `wc` and `tr` both succeeded, and under
  # `set -e` that ends the script. So the very first DEAD column -- the whole
  # point of the report -- was the one thing that made it die, silently,
  # after printing the heading and nothing else.
  hits=$( { grep -rIl --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.py" \
              --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.venv \
              -w -e "$col" "$REPO/apps/web" "$REPO/services" 2>/dev/null || true; } | wc -l | tr -d ' ')

  if [ "$hits" = "0" ]; then
    printf '  %-26s %-26s %8s  %s\n' "$tbl" "$col" "$rows" "none"
    dead=$((dead + 1))
  else
    printf '%s|%s|%s|%s\n' "$tbl" "$col" "$rows" "$hits" >> "$waiting_list"
    waiting=$((waiting + 1))
  fi
done < "$OUT"

[ "$dead" = "0" ] && echo "  (none — every empty column is at least referenced somewhere)"

echo
echo "=== WAITING — empty, but the application does mention it ==============="
echo
echo "  Not a bug on its own. A feature that has not run yet looks exactly"
echo "  like this: driver_licences is empty because migration 095 landed on"
echo "  11 September and no shift has started since. Worth a glance for"
echo "  anything that SHOULD have run by now."
echo
printf '  %-26s %-26s %8s  %s\n' "TABLE" "COLUMN" "ROWS" "FILES MENTIONING IT"
printf '  %-26s %-26s %8s  %s\n' "--------------------------" "--------------------------" "--------" "--------------------"
if [ -s "$waiting_list" ]; then
  while IFS='|' read -r tbl col rows hits; do
    # A column called `note` or `status` matches half the codebase because it
    # is an ordinary English word, not because anything writes that column.
    # Said plainly rather than left for the reader to be misled by: a high
    # number here is weaker evidence than a low one, which is the opposite of
    # how a count usually reads.
    if [ "$hits" -gt 20 ]; then
      printf '  %-26s %-26s %8s  %s\n' "$tbl" "$col" "$rows" "$hits — common word, discount this"
    else
      printf '  %-26s %-26s %8s  %s\n' "$tbl" "$col" "$rows" "$hits"
    fi
  done < "$waiting_list"
else
  echo "  (none)"
fi
rm -f "$waiting_list"

cat <<NOTE

=== HOW TO READ THIS =================================================

  $dead dead, $waiting waiting, out of $total nullable columns.

BEFORE DROPPING ANYTHING, CHECK FOR A SQL WRITER.

This searches apps/web and services/. It does NOT search db/, because a
column always appears in the migration that created it and counting that
would make every column look alive.

The cost of that is real: a column written only by a SQL FUNCTION OR
PROCEDURE defined in a migration will appear in the DEAD pile even though
something fills it on every run. engine_runs.scenario is the worked
example -- migration 089 sets it from app_settings, and it is null only
because nobody has ever set the service-level dial.

So for anything you are about to drop:

  grep -n "<column>" db/migrations/*.sql | grep -v "create table"

If it turns up inside a create function or create procedure, it is not
dead. It is unset, which is a different problem with a different fix.

DEAD is the pile that matters. Each row is a field that exists in the
schema, is empty in every row in production, and is not mentioned
anywhere in the application. Nothing can ever fill it.

That is not automatically a defect. Some of these will be columns nobody
ever needed, and the right answer is to drop them so the next person
reading the schema is not misled about what the system records. Some
will be a promise the schema makes and the code does not keep, which is
the one to care about -- deliveries.store_sig_name is exactly that: the
store signs, the image is kept, and who signed is never recorded.

WAITING needs judgement rather than action. Ask of each one: should this
have run by now? If yes, it is the licence-photo bug again.

A column being empty proves nothing on its own. 799 of the 801
deliveries were seeded in one go on 24 August, so plenty here is empty
for reasons that are nobody's fault. The grep is what separates "not
yet" from "never".

Nothing was written to. Every statement was a SELECT.

NOTE
