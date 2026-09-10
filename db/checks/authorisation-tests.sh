#!/usr/bin/env bash
#
# authorisation-tests.sh -- condition 15 of the decision record, measured.
#
#   "Three authorisation tests in CI: a driver cannot read another driver's
#    run, a restricted role cannot write where it should not, and an
#    unauthenticated request returns nothing from any table."
#                                    -- Fred, stack decision record v1.1.0
#
# Open since 11 August. It was never blocked on writing tests; it was blocked on
# there being no way to get a database to test against. That was fixed on
# 10 September by rebuild-from-migrations.sh, which this runs on top of.
#
# WHAT IT ACTUALLY FOUND
#
# Two of the three hold. The first does not, and not because a policy is
# missing -- because THERE IS NO DRIVER-TO-RUN ASSIGNMENT IN THIS SYSTEM. Every
# driver is shown every run and picks one (DriverApp.chooseRun). No policy can
# express "another driver's run" against a model that has no such thing.
#
# So test 1 reports as an open gap rather than a failure, and asserts that the
# gap is exactly the size it was measured to be. If someone builds run
# assignment, or if the exposure ever gets wider, this stops matching and says
# so. A permanently red light is one people stop reading -- this project spent
# six CI runs learning that on the gitleaks licence.
#
# Usage:
#   DATABASE_URL=postgres://... db/checks/authorisation-tests.sh
#
# The database is REBUILT. Point it at a throwaway; it refuses Supabase.
#
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
: "${DATABASE_URL:?set DATABASE_URL to a THROWAWAY database}"
case "$DATABASE_URL" in
  *supabase.co*|*supabase.com*|*pooler.supabase*)
    echo "REFUSING: DATABASE_URL points at Supabase."; exit 1 ;;
esac

q() { psql "$DATABASE_URL" -tAq -v ON_ERROR_STOP=1 "$@" 2>&1; }

# As a given user, at the application's own database role. `set role jbo_app`
# matters: the owner bypasses RLS unless FORCE is on, and testing as the owner
# would pass everything for the wrong reason.
as_user() {
  local uid="$1"; shift
  psql "$DATABASE_URL" -tAq 2>&1 \
    -c "set role jbo_app" \
    -c "set request.jwt.claim.sub = '$uid'" \
    "$@" | grep -v '^SET$'
}
as_nobody() {
  psql "$DATABASE_URL" -tAq 2>&1 -c "set role jbo_app" "$@" | grep -v '^SET$'
}

DRIVER_A='a0000000-0000-0000-0000-000000000001'
DRIVER_B='a0000000-0000-0000-0000-000000000002'
PACKER='a0000000-0000-0000-0000-000000000003'

echo "Rebuilding the database…"
DATABASE_URL="$DATABASE_URL" bash "$here/rebuild-from-migrations.sh" >/dev/null || {
  echo "FAIL  the database could not be rebuilt, so nothing below can be trusted."
  exit 1
}

echo "Seeding two drivers, a packer, two runs and two stores…"
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 >/dev/null <<SQL || { echo "FAIL  seed failed"; exit 1; }
insert into auth.users (id, email) values
 ('$DRIVER_A','driver.a@test'), ('$DRIVER_B','driver.b@test'), ('$PACKER','packer@test')
on conflict (id) do nothing;
insert into public.users (id, email, full_name, role, is_active) values
 ('$DRIVER_A','driver.a@test','Driver A','driver',true),
 ('$DRIVER_B','driver.b@test','Driver B','driver',true),
 ('$PACKER','packer@test','Packer','packer',true)
on conflict (id) do update set role = excluded.role, is_active = true;
insert into regions (id, name) values ('b0000000-0000-0000-0000-000000000001','Test Region') on conflict do nothing;
insert into runs (id, name, region_id) values
 ('c0000000-0000-0000-0000-000000000001','TEST Run North','b0000000-0000-0000-0000-000000000001'),
 ('c0000000-0000-0000-0000-000000000002','TEST Run South','b0000000-0000-0000-0000-000000000001')
on conflict do nothing;
insert into stores (id, name, retailer, region_id, default_run_id, active) values
 ('d0000000-0000-0000-0000-000000000001','TEST Store North','coles','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000001',true),
 ('d0000000-0000-0000-0000-000000000002','TEST Store South','coles','b0000000-0000-0000-0000-000000000001','c0000000-0000-0000-0000-000000000002',true)
on conflict do nothing;
-- A product and a delivery header, so section 4 can test the two writes the
-- driver app actually makes at a stop rather than a stand-in for them.
insert into products (id, name) values
 ('e0000000-0000-0000-0000-000000000001','TEST Sourdough')
on conflict do nothing;
insert into deliveries (id, store_id, delivery_date, status) values
 ('f0000000-0000-0000-0000-000000000001','d0000000-0000-0000-0000-000000000001',current_date,'delivered')
on conflict do nothing;
SQL

fails=0
ok()   { printf 'PASS  %s\n' "$1"; }
bad()  { printf 'FAIL  %s\n' "$1"; [ -n "${2:-}" ] && printf '        %s\n' "$2"; fails=$((fails+1)); }

echo
echo "── 1. A driver cannot read another driver's run ──"
echo
runs_seen="$(as_user "$DRIVER_A" -c "select count(*) from runs where name like 'TEST %'")"
if [ "$runs_seen" = "2" ]; then
  cat <<'NOTE'
OPEN  NOT MET, and not by a missing policy.

      Driver A can read both test runs. There is no driver-to-run assignment
      anywhere in this system: DriverApp shows every run and the driver picks
      one. "Another driver's run" is not a thing the data model can express, so
      no policy can enforce it.

      Closing this means building run assignment first. Recorded here rather
      than quietly counted as done.
NOTE
else
  bad "the exposure changed" "Driver A now sees $runs_seen of 2 test runs. Either run assignment was built -- update this test -- or something else moved."
fi

echo
echo "── 2. A restricted role cannot write where it should not ──"
echo

# The statement is wrapped so it RETURNS the number of rows it changed. psql's
# "UPDATE 0" command tag is not available in quiet tuples-only mode, and the
# first version of this file matched on it and reported three false failures --
# a test that lies in the safe direction is worse than no test.
check_refused() {
  local label="$1" uid="$2" stmt="$3"
  local out; out="$(as_user "$uid" -c "with x as ($stmt returning 1) select count(*) from x")"
  # Two shapes of refusal, both correct: the policy rejects the statement, or
  # it filters every candidate row away so nothing is changed.
  if printf '%s' "$out" | grep -qE 'row-level security|permission denied'; then
    ok "$label (refused outright)"
  elif [ "$(printf '%s' "$out" | tr -d '[:space:]')" = "0" ]; then
    ok "$label (no rows were visible to change)"
  else
    bad "$label" "expected a refusal, changed rows: $out"
  fi
}

check_refused "a driver cannot rename a store" "$DRIVER_A" \
  "update stores set name='HACKED' where id='d0000000-0000-0000-0000-000000000002'"
check_refused "a driver cannot write the production board" "$DRIVER_A" \
  "insert into daily_run_state(surface,day,approved) values ('production',current_date,'{}'::jsonb)"
check_refused "a driver cannot promote themselves to admin" "$DRIVER_A" \
  "update public.users set role='admin' where id='$DRIVER_A'"
check_refused "a driver cannot delete sales history" "$DRIVER_A" \
  "delete from sales_daily"
check_refused "a packer cannot write the driver surface" "$PACKER" \
  "insert into daily_run_state(surface,day,approved) values ('driver',current_date,'{}'::jsonb)"

echo
echo "── 3. An unauthenticated request returns nothing from any table ──"
echo

role_seen="$(as_nobody -c "select coalesce(public.current_app_role(),'(none)')")"
[ "$role_seen" = "(none)" ] \
  && ok "no session resolves to no role" \
  || bad "no session resolved to a role" "got: $role_seen"

# Every base table, not a chosen few. A condition that says "any table" is
# worth reading literally -- the one that leaks will be the one nobody listed.
leaky="$(psql "$DATABASE_URL" -tAq 2>/dev/null <<'SQL'
set role jbo_app;
do $$
declare t text; n bigint; bad text := '';
begin
  for t in select tablename from pg_tables where schemaname = 'public' order by 1 loop
    execute format('select count(*) from public.%I', t) into n;
    if n > 0 then bad := bad || t || '(' || n || ') '; end if;
  end loop;
  if bad <> '' then raise notice 'LEAKY: %', bad; end if;
end $$;
SQL
)"
if printf '%s' "$leaky" | grep -q 'LEAKY'; then
  bad "some tables return rows with no session" "$(printf '%s' "$leaky" | sed 's/^NOTICE:  //')"
else
  ok "every public table returns zero rows with no session"
fi

echo
echo "── 4. A driver CAN write what a driver is for ──"
echo

# The three checks above are all "this must be refused", and a suite made only
# of those has a failure mode: delete every driver policy and it goes greener,
# not redder. On 10 September that was not hypothetical. 25c926d taught the
# driver app to write delivery_items and the wastage commit taught it to write
# wastage, and neither table had a driver INSERT policy -- the app worked only
# because AUTH_ENFORCED is still off. Both would have started failing on a
# phone, at a store, the morning of the flip.
#
# So the permissions the floor NEEDS are asserted here too, and this section
# going red means the driver app has quietly stopped being able to do its job.
check_allowed() {
  local label="$1" uid="$2" stmt="$3"
  local out; out="$(as_user "$uid" -c "with x as ($stmt returning 1) select count(*) from x")"
  if [ "$(printf '%s' "$out" | tr -d '[:space:]')" = "1" ]; then
    ok "$label"
  else
    bad "$label" "expected one row written, got: $out"
  fi
}

ITEM="insert into delivery_items (delivery_id, product_id, qty_sent) values ('f0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000001',%s) on conflict (delivery_id, product_id) do update set qty_sent = excluded.qty_sent"
WASTE="insert into wastage (store_id, product_id, waste_date, qty) values ('d0000000-0000-0000-0000-000000000001','e0000000-0000-0000-0000-000000000001',current_date,%s) on conflict (store_id, product_id, waste_date) do update set qty = excluded.qty"

check_allowed "a driver can record what was delivered" "$DRIVER_A" \
  "$(printf "$ITEM" 12)"
# The second tap takes the UPDATE arm of the upsert, which is a different
# policy. An INSERT policy on its own passes this test's first half and fails
# a driver correcting a count at the stop.
check_allowed "a driver can correct a delivered count" "$DRIVER_A" \
  "$(printf "$ITEM" 14)"
check_allowed "a driver can record a confirmed nil at the shelf" "$DRIVER_A" \
  "$(printf "$WASTE" 0)"
check_allowed "a driver can re-count the shelf" "$DRIVER_A" \
  "$(printf "$WASTE" 3)"

# Writing is not deleting. A wrong number is corrected by writing the right
# one, which leaves the correction visible.
check_refused "a driver cannot delete a shelf count" "$DRIVER_A" \
  "delete from wastage"
check_refused "a driver cannot delete what was delivered" "$DRIVER_A" \
  "delete from delivery_items"

stored="$(psql "$DATABASE_URL" -tAq -c "select qty from wastage where store_id='d0000000-0000-0000-0000-000000000001'")"
[ "$(printf '%s' "$stored" | tr -d '[:space:]')" = "3" ] \
  && ok "the re-count is what is actually stored" \
  || bad "the re-count did not land" "wastage.qty is: $stored"

echo
if [ "$fails" -ne 0 ]; then
  echo "$fails check(s) FAILED."
  exit 1
fi
echo "Condition 15: two of three hold and are enforced. The first is an open"
echo "design gap, named above, not a silent one."
