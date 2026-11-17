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

# 4. The test files, in order. The rollback rehearsal is last and has
#    preconditions of its own.
for f in "$HERE"/sql/[0-9]*.sql; do
  case "$(basename "$f")" in
    90_rollback_in_transaction.sql)
      ready=1
      for need in "$MIG_CORE" "$MIG_DRILL" "$RB_DRILL" "$RB_CORE"; do
        if [ ! -f "$need" ]; then
          fail "[c14] rollback rehearsal not run :: supabase/${need#"$SUPA"/} is missing"
          ready=0
        elif grep -E -i -q '^[[:space:]]*(begin|commit|rollback|start[[:space:]]+transaction)[[:space:]]*;' "$need"; then
          # The rehearsal wraps the scripts in a transaction it rolls back. A
          # script that commits on its own would make the rehearsal permanent.
          fail "[c14] rollback rehearsal not run :: supabase/${need#"$SUPA"/} contains transaction control (BEGIN/COMMIT/ROLLBACK)"
          ready=0
        fi
      done
      [ "$ready" -eq 1 ] && run_file "$f"
      ;;
    *) run_file "$f" ;;
  esac
done

echo "# ${LABEL}total: $total checks, $passed passed, $failed failed"
[ "$failed" -eq 0 ]
