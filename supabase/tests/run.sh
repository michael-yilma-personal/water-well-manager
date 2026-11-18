#!/usr/bin/env bash
#
# Database tests for the tenancy work (SaaS Phase 1, criteria 1-12, 14, 16).
#
#   supabase/tests/run.sh                 the whole suite
#   supabase/tests/run.sh FILE.sql ...    only these test files
#
# Runs against the database named by the standard PG* environment variables,
# which must be a LOCAL one built from every file in supabase/migrations:
#
#   CI      the `database` job, after `supabase db start`, with the same PG*
#           environment as the neighbouring steps of that job:
#             supabase/tests/run.sh
#   laptop  supabase/tests/local.sh builds a throwaway cluster and calls this.
#
# It refuses any host that is not this machine. Staging and production are
# never a target: the files create accounts and organizations (inside
# transactions that are rolled back) and the last one rehearses the rollback.
#
# Output: one line per check, `ok - name` or `FAIL - name :: what happened`,
# then a total. Exit status 0 only when every check passed.
#
# How a test file works: see lib/helpers.sql. Each file is one transaction
# that is rolled back; each check is run in a subtransaction as the user it
# names. psql runs with ON_ERROR_ROLLBACK so that a statement that fails
# outside a check is reported (as a failure) without hiding the checks after
# it. Every file ends with a `done` marker and declares how many checks it
# holds (`-- plan: N`), so a file that stops early or loses checks is a
# failure too.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

# DRILL_TEST_SUPABASE_DIR points the tests at another copy of the supabase/
# directory. It exists for trying the tests themselves against scratch
# migrations; CI and normal runs leave it unset.
SUPA="${DRILL_TEST_SUPABASE_DIR:-$ROOT/supabase}"
MIG_CORE="$SUPA/migrations/20261116000000_saas_core.sql"
MIG_DRILL="$SUPA/migrations/20261116010000_drill_tenancy.sql"
RB_CORE="$SUPA/rollback/20261116000000_saas_core.sql"
RB_DRILL="$SUPA/rollback/20261116010000_drill_tenancy.sql"

LABEL="${RUN_LABEL:+[$RUN_LABEL] }"

# --- Local targets only -----------------------------------------------------

refuse() {
  echo "run.sh: $1" >&2
  echo "run.sh: these tests run only against a local database (PGHOST=127.0.0.1, localhost, or a socket directory)." >&2
  exit 2
}

case "${PGHOST:-}" in
  127.0.0.1|localhost|::1|/*) ;;
  "") refuse "PGHOST is not set." ;;
  *)  refuse "PGHOST is '${PGHOST}', which is not this machine." ;;
esac
case "${PGHOSTADDR:-}" in
  ""|127.0.0.1|::1) ;;
  *) refuse "PGHOSTADDR is '${PGHOSTADDR}', which is not this machine." ;;
esac
# A service file or a connection URI can name another host behind PGHOST's back.
[ -z "${PGSERVICE:-}" ] || refuse "PGSERVICE is set; unset it."
case "${PGDATABASE:-}" in
  *://*|*=*) refuse "PGDATABASE must be a plain database name." ;;
esac

command -v psql >/dev/null 2>&1 || { echo "run.sh: psql is not on PATH." >&2; exit 2; }

if ! psql -X -q -At -c 'select 1' >/dev/null 2>&1; then
  echo "run.sh: cannot connect to the database at PGHOST=${PGHOST} PGPORT=${PGPORT:-5432}." >&2
  exit 2
fi

# --- Counting ---------------------------------------------------------------

total=0
passed=0
failed=0

pass() { total=$((total + 1)); passed=$((passed + 1)); echo "ok - ${LABEL}$1"; }
fail() { total=$((total + 1)); failed=$((failed + 1)); echo "FAIL - ${LABEL}$1"; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/drill-dbtest.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

# Run one test file and fold its lines into the totals.
run_file() {
  local file="$1" name out err rc line checks=0 plan saw_done=0
  name="$(basename "$file")"
  out="$TMP/out"
  err="$TMP/err"

  PGOPTIONS="-c client_min_messages=warning" psql -X -q -At \
    -v ON_ERROR_STOP=0 -v ON_ERROR_ROLLBACK=on -v VERBOSITY=terse \
    -v mig_core="$MIG_CORE" -v mig_drill="$MIG_DRILL" \
    -v rollback_core="$RB_CORE" -v rollback_drill="$RB_DRILL" \
    -f "$file" >"$out" 2>"$err"
  rc=$?

  while IFS= read -r line; do
    case "$line" in
      "ok - "*)   checks=$((checks + 1)); pass "${line#ok - }" ;;
      "FAIL - "*) checks=$((checks + 1)); fail "${line#FAIL - }" ;;
      "done")     saw_done=1 ;;
      "")         ;;
      *)          echo "# $name: $line" ;;
    esac
  done <"$out"

  # Anything psql or the server reported outside a check.
  while IFS= read -r line; do
    case "$line" in
      *"ERROR:"*|*"FATAL:"*|*" error: "*)
        fail "$name: a statement outside a check failed :: ${line#psql:}" ;;
      "") ;;
      *)  echo "# $name: $line" ;;
    esac
  done <"$err"

  [ "$rc" -eq 0 ] || fail "$name: psql exited with status $rc"
  [ "$saw_done" -eq 1 ] || fail "$name: did not run to its end"

  plan="$(sed -n 's/^-- plan: \([0-9][0-9]*\)$/\1/p' "$file" | head -n 1)"
  if [ -z "$plan" ]; then
    fail "$name: declares no plan (-- plan: N)"
  elif [ "$plan" -ne "$checks" ]; then
    fail "$name: holds $plan checks but $checks ran"
  else
    pass "$name: all $plan planned checks ran"
  fi
}

# --- Only the named files ---------------------------------------------------

if [ "$#" -gt 0 ]; then
  for f in "$@"; do
    if [ -f "$f" ]; then run_file "$f"; else fail "$f: no such test file"; fi
  done
  echo "# ${LABEL}total: $total checks, $passed passed, $failed failed"
  [ "$failed" -eq 0 ]
  exit $?
fi

# --- The whole suite ----------------------------------------------------------

# 1. The files the Developer and the tests agreed on.
[ -f "$MIG_CORE" ]  && pass "[c1] the foundation migration exists: supabase/${MIG_CORE#"$SUPA"/}"  || fail "[c1] the foundation migration exists: supabase/${MIG_CORE#"$SUPA"/} :: file not found"
[ -f "$MIG_DRILL" ] && pass "[c5] the Drill migration exists: supabase/${MIG_DRILL#"$SUPA"/}"      || fail "[c5] the Drill migration exists: supabase/${MIG_DRILL#"$SUPA"/} :: file not found"
[ -f "$RB_DRILL" ]  && pass "[c14] the Drill rollback script exists: supabase/${RB_DRILL#"$SUPA"/}" || fail "[c14] the Drill rollback script exists: supabase/${RB_DRILL#"$SUPA"/} :: file not found"
[ -f "$RB_CORE" ]   && pass "[c14] the foundation rollback script exists: supabase/${RB_CORE#"$SUPA"/}" || fail "[c14] the foundation rollback script exists: supabase/${RB_CORE#"$SUPA"/} :: file not found"

# 2. Section A: the foundation's code names nothing of Drill's. Comments are
#    not code and are left out; badge_number is a foundation column (criterion 1).
name="[A] saas_core names no Drill table, role, function or bucket in its code"
if [ -f "$MIG_CORE" ]; then
  hits="$(sed -e 's/--.*$//' "$MIG_CORE" \
    | grep -n -E -i '(^|[^a-z_])(boreholes|pipe_records|drilling_events|shift_logs|profiles|is_admin|is_reviewer|handle_new_user|drilling[-_]photos)([^a-z_]|$)' || true)"
  roles="$(sed -e 's/--.*$//' "$MIG_CORE" \
    | grep -n -E '(Driller|Data Logger|Supervisor|Administrator)' || true)"
  if [ -z "$hits$roles" ]; then
    pass "$name"
  else
    fail "$name :: $(printf '%s\n%s' "$hits" "$roles" | grep -v '^$' | head -n 5 | tr '\n' ';')"
  fi
else
  fail "$name :: file not found"
fi

# 3. Criterion 16: the schema check against the database built from the migrations.
name="[c16] schema check: every table in public has RLS, and org_id or an allowlist entry"
violations="$(psql -X -q -At -v ON_ERROR_STOP=1 -f "$HERE/schema_check.sql" \
  -c "select table_name || ' (' || problem || ')' from schema_check_violations order by 1" 2>"$TMP/sc.err")"
rc=$?
if [ "$rc" -ne 0 ]; then
  fail "$name :: the check itself failed: $(head -n 1 "$TMP/sc.err")"
elif [ -n "$violations" ]; then
  fail "$name :: $(printf '%s' "$violations" | tr '\n' ';' | sed 's/;/; /g')"
else
  pass "$name"
fi

# 4. Transaction control in a migration or rollback file. Three things below
#    run those files inside a transaction they roll back; a file that commits
#    on its own would make the rehearsal permanent, and decision 24 forbids
#    it anyway. The detector is tried first, on every spelling, because a
#    detector that misses one is how such a file would get through.
SPLITTER="$HERE/lib/sql_statements.py"
have_python=1
command -v python3 >/dev/null 2>&1 || have_python=0

has_txn_control() { python3 "$SPLITTER" txn-control "$1" >/dev/null 2>&1; [ "$?" -eq 1 ]; }

txn_case() {   # txn_case yes|no "label" "sql"
  local expect="$1" label="$2" got="no"
  printf '%s\n' "$3" >"$TMP/txn_case.sql"
  if [ "$have_python" -eq 0 ]; then
    fail "[c31] transaction-control detector: $label :: python3 is not on PATH"
    return
  fi
  python3 "$SPLITTER" txn-control "$TMP/txn_case.sql" >/dev/null 2>"$TMP/txn_case.err"
  case "$?" in
    0) got="no" ;;
    1) got="yes" ;;
    *) fail "[c31] transaction-control detector: $label :: the detector itself failed: $(head -n 1 "$TMP/txn_case.err")"; return ;;
  esac
  if [ "$got" = "$expect" ]; then
    pass "[c31] transaction-control detector: $label"
  else
    fail "[c31] transaction-control detector: $label :: expected $expect, got $got"
  fi
}

txn_case yes "reports begin;"                         'create table a (i int); begin; select 1;'
txn_case yes "reports BEGIN TRANSACTION;"             'BEGIN TRANSACTION;'
txn_case yes "reports begin work;"                    'begin work;'
txn_case yes "reports start transaction;"             'start   transaction isolation level serializable;'
txn_case yes "reports commit;"                        'select 1;
commit;'
txn_case yes "reports commit work;"                   'select 1; commit work;'
txn_case yes "reports commit transaction;"            'COMMIT TRANSACTION;'
txn_case yes "reports end;"                           'select 1;
end;'
txn_case yes "reports END WORK;"                      'END WORK;'
txn_case yes "reports abort;"                         'abort;'
txn_case yes "reports rollback;"                      '  Rollback ;'
txn_case yes "reports rollback work;"                 'rollback work;'
txn_case yes "reports commit after a comment"         '-- done
/* really */ commit;'
txn_case yes "reports commit as the last statement with no semicolon" 'select 1; commit'
txn_case yes "reports end; after a function body that has its own end;" 'do $$ begin perform 1; end; $$;
end;'
txn_case no  "ignores begin and end; inside a DO block" 'do $$
begin
  perform 1;
end;
$$;'
txn_case no  "ignores begin and end; inside a tagged function body" 'create function f() returns void language plpgsql as $fn$
begin
  begin
    perform 1;
  end;
  commit;
end;
$fn$;'
txn_case no  "ignores commit; in a line comment"      'select 1; -- commit;
select 2;'
txn_case no  "ignores commit; in a block comment"     'select 1; /* commit; */ select 2;'
txn_case no  "ignores commit; in a string"            "select 'x; commit; y';"
txn_case no  "ignores case ... end;"                  'select case when true then 1 end;'
txn_case no  "ignores rollback to savepoint"          'savepoint s; rollback to savepoint s;'
txn_case no  "ignores a column named end"             'select "end", "commit" from t;'

# Whether the four files may be run inside a transaction here.
ready=1
for need in "$MIG_CORE" "$MIG_DRILL" "$RB_DRILL" "$RB_CORE"; do
  what="[c24] supabase/${need#"$SUPA"/} contains no transaction control"
  if [ ! -f "$need" ]; then
    fail "$what :: file not found"
    ready=0
  elif [ "$have_python" -eq 0 ]; then
    fail "$what :: not checked, python3 is not on PATH"
    ready=0
  elif has_txn_control "$need"; then
    fail "$what :: $(python3 "$SPLITTER" txn-control "$need" | head -n 3 | tr '\n' ';')"
    ready=0
  elif ! python3 "$SPLITTER" txn-control "$need" >/dev/null 2>&1; then
    fail "$what :: the detector itself failed"
    ready=0
  else
    pass "$what"
  fi
done

# Decision 31: the Drill rollback refuses when two organizations hold records.
rollback_refuses() {
  local out="$TMP/guard.out" rc
  psql -X -q -At -v ON_ERROR_STOP=1 -v rollback_drill="$RB_DRILL" \
    -f "$HERE/guards/rollback_refuses.sql" >"$out" 2>"$TMP/guard.err"
  rc=$?
  if ! grep -q '^FIXTURE-READY$' "$out"; then
    fail "[c31] the Drill rollback refuses when two organizations hold records :: not checked, the fixture did not load: $(head -n 1 "$TMP/guard.err")"
  elif grep -q '^REACHED-END$' "$out" || [ "$rc" -eq 0 ]; then
    fail "[c31] the Drill rollback refuses when two organizations hold records :: the script ran to its end without raising"
  else
    pass "[c31] the Drill rollback refuses when two organizations hold records"
  fi
  # It ran inside a transaction that psql abandoned, so nothing may have changed.
  if [ "$(psql -X -q -At -c "select (to_regclass('public.organizations') is not null and exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped) and not exists (select 1 from public.organizations where name = 'Second company'))::int" 2>/dev/null)" = "1" ]; then
    pass "[c31] ... and the database is as it was"
  else
    fail "[c31] ... and the database is as it was :: tenancy objects are missing or the test's rows were left behind"
  fi
}

# Decisions 27 and 30: on a first application with several organizations and
# none marked founding, the Drill migration raises instead of picking one.
first_run_refuses() {
  local out="$TMP/first.out" rc
  psql -X -q -At -v ON_ERROR_STOP=1 -v mig_drill="$MIG_DRILL" \
    -f "$HERE/guards/first_run_refuses.sql" >"$out" 2>"$TMP/first.err"
  rc=$?
  if ! grep -q '^FIXTURE-READY$' "$out"; then
    fail "[c27][c30] a first application with several organizations and none marked founding raises instead of picking one :: not checked, the fixture did not load: $(head -n 1 "$TMP/first.err")"
  elif grep -q '^REACHED-END$' "$out" || [ "$rc" -eq 0 ]; then
    fail "[c27][c30] a first application with several organizations and none marked founding raises instead of picking one :: the migration ran to its end"
  elif ! grep -q -i 'founding' "$TMP/first.err"; then
    fail "[c27][c30] a first application with several organizations and none marked founding raises instead of picking one :: it stopped, but on something else: $(grep -m 1 -E 'ERROR|FATAL' "$TMP/first.err" | cut -c 1-200)"
  else
    pass "[c27][c30] a first application with several organizations and none marked founding raises instead of picking one"
  fi
  # It ran inside a transaction that psql abandoned, so nothing may have changed.
  if [ "$(psql -X -q -At -c "select ((select count(*) from public.organizations where is_founding) = 1 and not exists (select 1 from public.organizations where name = 'Second company (first run)'))::int" 2>/dev/null)" = "1" ]; then
    pass "[c27][c30] ... and the database is as it was: one organization is marked, the test's is gone"
  else
    fail "[c27][c30] ... and the database is as it was: one organization is marked, the test's is gone :: the mark is missing or the test's rows were left behind"
  fi
}

# 5. The test files, in order. The last three run migration or rollback files
#    inside a transaction and so wait on the check above.
for f in "$HERE"/sql/[0-9]*.sql; do
  case "$(basename "$f")" in
    80_reapply_in_transaction.sql)
      if [ "$ready" -eq 1 ]; then
        first_run_refuses
        run_file "$f"
      else
        fail "[c27][c30] first application with several organizations not tried :: see the transaction-control checks above"
        fail "[c31] second application of the Drill migration not tried :: see the transaction-control checks above"
      fi
      ;;
    85_drill_rollback_alone.sql)
      if [ "$ready" -eq 1 ]; then run_file "$f"; else fail "[c14] the Drill rollback on its own not tried :: see the transaction-control checks above"; fi
      ;;
    90_rollback_in_transaction.sql)
      if [ "$ready" -eq 1 ]; then
        rollback_refuses
        run_file "$f"
      else
        fail "[c31] rollback refusal not tried :: see the transaction-control checks above"
        fail "[c14] rollback rehearsal not run :: see the transaction-control checks above"
      fi
      ;;
    *) run_file "$f" ;;
  esac
done

echo "# ${LABEL}total: $total checks, $passed passed, $failed failed"
[ "$failed" -eq 0 ]
