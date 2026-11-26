#!/usr/bin/env bash
#
# Database tests for the tenancy work (SaaS Phase 1, criteria 1-12, 14, 16)
# and for member management (SaaS Phase 2, task P2-1, criteria 1-13; its
# checks are named [P2-1 cN]).
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
# SaaS Phase 2, task P2-1: member management.
MIG_SAAS_MEMBERS="$SUPA/migrations/20261123000000_saas_members.sql"
MIG_DRILL_MEMBERS="$SUPA/migrations/20261123010000_drill_members.sql"
RB_SAAS_MEMBERS="$SUPA/rollback/20261123000000_saas_members.sql"
RB_DRILL_MEMBERS="$SUPA/rollback/20261123010000_drill_members.sql"
# SaaS Phase 3, task P3-1: subscriptions. The timestamp is the Developer's.
MIG_SAAS_SUBSCRIPTIONS="$(ls "$SUPA"/migrations/*_saas_subscriptions.sql 2>/dev/null | head -n 1)"
MIG_SAAS_SUBSCRIPTIONS="${MIG_SAAS_SUBSCRIPTIONS:-$SUPA/migrations/<timestamp>_saas_subscriptions.sql}"
RB_SAAS_SUBSCRIPTIONS="$SUPA/rollback/$(basename "$MIG_SAAS_SUBSCRIPTIONS")"
# Task P3-2: Drill's use of them.
MIG_DRILL_SUBSCRIPTIONS="$(ls "$SUPA"/migrations/*_drill_subscriptions.sql 2>/dev/null | head -n 1)"
MIG_DRILL_SUBSCRIPTIONS="${MIG_DRILL_SUBSCRIPTIONS:-$SUPA/migrations/<timestamp>_drill_subscriptions.sql}"
RB_DRILL_SUBSCRIPTIONS="$SUPA/rollback/$(basename "$MIG_DRILL_SUBSCRIPTIONS")"
HAS_DRILL_SUBSCRIPTIONS=0; [ ! -f "$RB_DRILL_SUBSCRIPTIONS" ] || HAS_DRILL_SUBSCRIPTIONS=1
# SaaS Phase 4, task P4-1: the platform administrator's functions.
MIG_SAAS_PLATFORM="$(ls "$SUPA"/migrations/*_saas_platform.sql 2>/dev/null | head -n 1)"
MIG_SAAS_PLATFORM="${MIG_SAAS_PLATFORM:-$SUPA/migrations/<timestamp>_saas_platform.sql}"
RB_SAAS_PLATFORM="$SUPA/rollback/$(basename "$MIG_SAAS_PLATFORM")"
HAS_SAAS_PLATFORM=0; [ ! -f "$RB_SAAS_PLATFORM" ] || HAS_SAAS_PLATFORM=1
# Task P4-5: the console's audit history (saas_platform is applied to staging, so a new migration).
MIG_SAAS_PLATFORM_AUDIT="$(ls "$SUPA"/migrations/*_saas_platform_audit.sql 2>/dev/null | head -n 1)"
MIG_SAAS_PLATFORM_AUDIT="${MIG_SAAS_PLATFORM_AUDIT:-$SUPA/migrations/<timestamp>_saas_platform_audit.sql}"
RB_SAAS_PLATFORM_AUDIT="$SUPA/rollback/$(basename "$MIG_SAAS_PLATFORM_AUDIT")"
HAS_SAAS_PLATFORM_AUDIT=0; [ ! -f "$RB_SAAS_PLATFORM_AUDIT" ] || HAS_SAAS_PLATFORM_AUDIT=1

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

# P3-2: the guards try the Drill tenancy rollback on a database built from
# every migration. As in a real rollback (newest first), Drill's use of the
# subscriptions goes before it.
RB_DRILL_NEWEST_FIRST="$TMP/rollback_drill_newest_first.sql"
{ [ "$HAS_DRILL_SUBSCRIPTIONS" -eq 0 ] || echo "\\i '$RB_DRILL_SUBSCRIPTIONS'"; echo "\\i '$RB_DRILL'"; } >"$RB_DRILL_NEWEST_FIRST"

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
    -v mig_saas_members="$MIG_SAAS_MEMBERS" -v mig_drill_members="$MIG_DRILL_MEMBERS" \
    -v rollback_saas_members="$RB_SAAS_MEMBERS" -v rollback_drill_members="$RB_DRILL_MEMBERS" \
    -v rollback_saas_subscriptions="$RB_SAAS_SUBSCRIPTIONS" \
    -v rollback_drill_subscriptions="$RB_DRILL_SUBSCRIPTIONS" -v has_drill_subscriptions="$HAS_DRILL_SUBSCRIPTIONS" \
    -v rollback_saas_platform="$RB_SAAS_PLATFORM" -v has_saas_platform="$HAS_SAAS_PLATFORM" \
    -v rollback_saas_platform_audit="$RB_SAAS_PLATFORM_AUDIT" -v has_saas_platform_audit="$HAS_SAAS_PLATFORM_AUDIT" \
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

# 2b. SaaS Phase 2, task P2-1: the two member migrations and their rollback
#     scripts exist under the agreed names, and the reusable one names nothing
#     of Drill's (its section A). Beyond the list above: created_by is a
#     column of Drill's record tables, and is_founding and deactivated_by_ban
#     are columns the Drill migration adds to the foundation's tables.
for pair in "the reusable member migration:$MIG_SAAS_MEMBERS" "the Drill member migration:$MIG_DRILL_MEMBERS" \
            "the Drill member rollback script:$RB_DRILL_MEMBERS" "the reusable member rollback script:$RB_SAAS_MEMBERS"; do
  what="${pair%%:*}"; need="${pair#*:}"
  [ -f "$need" ] && pass "[P2-1] $what exists: supabase/${need#"$SUPA"/}" \
                 || fail "[P2-1] $what exists: supabase/${need#"$SUPA"/} :: file not found"
done

name="[P2-1 A] saas_members names no Drill table, column, role, function or bucket in its code"
if [ -f "$MIG_SAAS_MEMBERS" ]; then
  hits="$(sed -e 's/--.*$//' "$MIG_SAAS_MEMBERS" \
    | grep -n -E -i '(^|[^a-z_])(boreholes|pipe_records|drilling_events|shift_logs|profiles|is_admin|is_reviewer|handle_new_user|drilling[-_]photos|created_by|is_founding|deactivated_by_ban)([^a-z_]|$)' || true)"
  roles="$(sed -e 's/--.*$//' "$MIG_SAAS_MEMBERS" \
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

# The same for the four files of P2-1, kept apart so that the Phase 1
# rehearsals do not wait on them: 95_members_rollback.sql runs them inside a
# transaction it rolls back.
ready_members=1
for need in "$MIG_SAAS_MEMBERS" "$MIG_DRILL_MEMBERS" "$RB_DRILL_MEMBERS" "$RB_SAAS_MEMBERS"; do
  what="[P2-1] supabase/${need#"$SUPA"/} contains no transaction control"
  if [ ! -f "$need" ]; then
    fail "$what :: file not found"
    ready_members=0
  elif [ "$have_python" -eq 0 ]; then
    fail "$what :: not checked, python3 is not on PATH"
    ready_members=0
  elif has_txn_control "$need"; then
    fail "$what :: $(python3 "$SPLITTER" txn-control "$need" | head -n 3 | tr '\n' ';')"
    ready_members=0
  elif ! python3 "$SPLITTER" txn-control "$need" >/dev/null 2>&1; then
    fail "$what :: the detector itself failed"
    ready_members=0
  else
    pass "$what"
  fi
done

# SaaS Phase 3, task P3-1: the reusable subscriptions migration and its
# rollback script. Once they exist the rehearsals roll the migration back
# first (sql/inc/roll_back_later.sql), so they wait on these two as well.
for need in "$MIG_SAAS_SUBSCRIPTIONS" "$RB_SAAS_SUBSCRIPTIONS"; do
  what="[P3-1] supabase/${need#"$SUPA"/} exists and contains no transaction control"
  if [ ! -f "$need" ]; then
    fail "$what :: file not found"
  elif [ "$have_python" -eq 0 ] || has_txn_control "$need" || ! python3 "$SPLITTER" txn-control "$need" >/dev/null 2>&1; then
    fail "$what :: $(python3 "$SPLITTER" txn-control "$need" 2>&1 | head -n 3 | tr '\n' ';')"
    ready=0
    ready_members=0
  else
    pass "$what"
  fi
done

name="[P3-1] saas_subscriptions names no Drill table, column, role, function or bucket in its code"
if [ -f "$MIG_SAAS_SUBSCRIPTIONS" ]; then
  hits="$(sed -e 's/--.*$//' "$MIG_SAAS_SUBSCRIPTIONS" \
    | grep -n -E -i '(^|[^a-z_])(boreholes|pipe_records|drilling_events|shift_logs|profiles|is_admin|is_reviewer|handle_new_user|drilling[-_]photos|created_by|is_founding|deactivated_by_ban)([^a-z_]|$)' || true)"
  roles="$(sed -e 's/--.*$//' "$MIG_SAAS_SUBSCRIPTIONS" \
    | grep -n -E '(Driller|Data Logger|Supervisor|Administrator)' || true)"
  if [ -z "$hits$roles" ]; then
    pass "$name"
  else
    fail "$name :: $(printf '%s\n%s' "$hits" "$roles" | grep -v '^$' | head -n 5 | tr '\n' ';')"
  fi
else
  fail "$name :: file not found"
fi
# Criterion 3: the refusal's code is documented where the Edge Function's
# author will look for it. SS001 is the tests' assumption (56_subscriptions.sql).
name="[P3-1 c3] the migration documents the SQLSTATE of the user-limit refusal (SS001)"
if grep -q 'SS001' "$MIG_SAAS_SUBSCRIPTIONS" 2>/dev/null; then pass "$name"; else fail "$name :: not found in the migration"; fi

# Task P3-2: the Drill migration and its rollback script, and the code the
# field app will look for (SS002 is the tests' assumption, 58_drill_subscriptions.sql).
for need in "$MIG_DRILL_SUBSCRIPTIONS" "$RB_DRILL_SUBSCRIPTIONS"; do
  what="[P3-2 c10] supabase/${need#"$SUPA"/} exists and contains no transaction control"
  if [ ! -f "$need" ]; then
    fail "$what :: file not found"
  elif [ "$have_python" -eq 0 ] || has_txn_control "$need" || ! python3 "$SPLITTER" txn-control "$need" >/dev/null 2>&1; then
    fail "$what :: $(python3 "$SPLITTER" txn-control "$need" 2>&1 | head -n 3 | tr '\n' ';')"
    ready=0
    ready_members=0
  else
    pass "$what"
  fi
done
name="[P3-2 c2] the migration documents the SQLSTATE of a write refused by the subscription (SS002)"
if grep -q 'SS002' "$MIG_DRILL_SUBSCRIPTIONS" 2>/dev/null; then pass "$name"; else fail "$name :: not found in the migration"; fi

# SaaS Phase 4, task P4-1 (criterion 7): the reusable platform migration and
# its rollback script, which the rehearsals run first (sql/inc/roll_back_later.sql).
# P4-5: and the audit history migration with its rollback.
for need in "$MIG_SAAS_PLATFORM" "$RB_SAAS_PLATFORM" "$MIG_SAAS_PLATFORM_AUDIT" "$RB_SAAS_PLATFORM_AUDIT"; do
  what="[P4-1 c7] supabase/${need#"$SUPA"/} exists and contains no transaction control"
  if [ ! -f "$need" ]; then
    fail "$what :: file not found"
  elif [ "$have_python" -eq 0 ] || has_txn_control "$need" || ! python3 "$SPLITTER" txn-control "$need" >/dev/null 2>&1; then
    fail "$what :: $(python3 "$SPLITTER" txn-control "$need" 2>&1 | head -n 3 | tr '\n' ';')"
    ready=0
    ready_members=0
  else
    pass "$what"
  fi
done
name="[P4-1 c7] saas_platform names no Drill table, column, role, function or bucket in its code"
if [ -f "$MIG_SAAS_PLATFORM" ]; then
  hits="$(sed -e 's/--.*$//' "$MIG_SAAS_PLATFORM" \
    | grep -n -E -i '(^|[^a-z_])(boreholes|pipe_records|drilling_events|shift_logs|profiles|is_admin|is_reviewer|handle_new_user|drilling[-_]photos|created_by|is_founding|deactivated_by_ban)([^a-z_]|$)' || true)"
  roles="$(sed -e 's/--.*$//' "$MIG_SAAS_PLATFORM" \
    | grep -n -E '(Driller|Data Logger|Supervisor|Administrator)' || true)"
  if [ -z "$hits$roles" ]; then
    pass "$name"
  else
    fail "$name :: $(printf '%s\n%s' "$hits" "$roles" | grep -v '^$' | head -n 5 | tr '\n' ';')"
  fi
else
  fail "$name :: file not found"
fi

# P2-1 criterion 4: the last-administrator rule with two real sessions
# (lib/members_concurrency.py says how). What it creates is committed and
# deleted again; its last line says whether the database is as it was.
members_concurrency() {
  local out="$TMP/conc.out" err="$TMP/conc.err" line n=0
  if [ "$have_python" -eq 0 ]; then
    fail "[P2-1 c4] the last-administrator rule under concurrency :: not checked, python3 is not on PATH"
    return
  fi
  python3 "$HERE/lib/members_concurrency.py" >"$out" 2>"$err"
  while IFS= read -r line; do
    case "$line" in
      "ok	"*)   n=$((n + 1)); pass "${line#ok	}" ;;
      "FAIL	"*) n=$((n + 1)); fail "${line#FAIL	}" ;;
      "")       ;;
      *)        echo "# members_concurrency.py: $line" ;;
    esac
  done <"$out"
  # The tool's own check, nine cases, the last seat (P3-1), its end and the cleanup.
  if [ "$n" -ne 13 ] || [ -s "$err" ]; then
    fail "[harness] concurrency: lib/members_concurrency.py printed its thirteen lines and nothing else :: $n line(s); $(head -n 1 "$err" | cut -c 1-200)"
  fi
}

# Decision 31: the Drill rollback refuses when two organizations hold records.
rollback_refuses() {
  local out="$TMP/guard.out" rc
  psql -X -q -At -v ON_ERROR_STOP=1 -v rollback_drill="$RB_DRILL_NEWEST_FIRST" \
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

# Decision 41: it also refuses when another organization has a membership and
# no records at all.
rollback_refuses_members() {
  local out="$TMP/guard41.out" rc what="[c41] the Drill rollback refuses when a non-founding organization has a membership but no records"
  psql -X -q -At -v ON_ERROR_STOP=1 -v rollback_drill="$RB_DRILL_NEWEST_FIRST" \
    -f "$HERE/guards/rollback_refuses_members.sql" >"$out" 2>"$TMP/guard41.err"
  rc=$?
  if ! grep -q '^FIXTURE-READY$' "$out"; then
    fail "$what :: not checked, the fixture did not load: $(head -n 1 "$TMP/guard41.err")"
  elif grep -q '^REACHED-END$' "$out" || [ "$rc" -eq 0 ]; then
    fail "$what :: the script ran to its end without raising"
  else
    pass "$what"
  fi
  # It ran inside a transaction that psql abandoned, so nothing may have changed.
  if [ "$(psql -X -q -At -c "select (to_regclass('public.organizations') is not null and exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped) and not exists (select 1 from public.organizations where name = 'Second company (members only)'))::int" 2>/dev/null)" = "1" ]; then
    pass "[c41] ... and the database is as it was"
  else
    fail "[c41] ... and the database is as it was :: tenancy objects are missing or the test's rows were left behind"
  fi
}

# Decision 41 with no organization marked founding (added in the validation
# of f1aabbe). Two organizations with members: the rollback raises. One
# organization with members and a second, empty one: it runs (the Developer's
# reading where the decision is silent).
rollback_unflagged() {
  local out="$TMP/guard41u.out" rc what
  local intact="select (to_regclass('public.organizations') is not null and exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped) and (select count(*) from public.organizations where is_founding) = 1 and not exists (select 1 from public.organizations where name like 'Second company (no mark%'))::int"

  what="[c41] the Drill rollback refuses when no organization is marked founding and two organizations have members"
  psql -X -q -At -v ON_ERROR_STOP=1 -v rollback_drill="$RB_DRILL_NEWEST_FIRST" \
    -f "$HERE/guards/rollback_unflagged_two.sql" >"$out" 2>"$TMP/guard41u.err"
  rc=$?
  if ! grep -q '^FIXTURE-READY$' "$out"; then
    fail "$what :: not checked, the fixture did not load: $(head -n 1 "$TMP/guard41u.err")"
  elif grep -q '^REACHED-END$' "$out" || [ "$rc" -eq 0 ]; then
    fail "$what :: the script ran to its end without raising"
  elif ! grep -q -i 'refusing to roll back' "$TMP/guard41u.err"; then
    fail "$what :: it stopped, but on something else: $(grep -m 1 -E 'ERROR|FATAL' "$TMP/guard41u.err" | cut -c 1-200)"
  else
    pass "$what"
  fi
  if [ "$(psql -X -q -At -c "$intact" 2>/dev/null)" = "1" ]; then
    pass "[c41] ... and the database is as it was"
  else
    fail "[c41] ... and the database is as it was :: tenancy objects or the mark are missing, or the test's rows were left behind"
  fi

  what="[c41] (Developer's reading) with no organization marked founding and members in one organization only, the Drill rollback runs"
  psql -X -q -At -v ON_ERROR_STOP=1 -v rollback_drill="$RB_DRILL_NEWEST_FIRST" \
    -f "$HERE/guards/rollback_unflagged_one.sql" >"$out" 2>"$TMP/guard41u.err"
  rc=$?
  if ! grep -q '^FIXTURE-READY$' "$out"; then
    fail "$what :: not checked, the fixture did not load: $(head -n 1 "$TMP/guard41u.err")"
  elif [ "$rc" -ne 0 ] || ! grep -q '^REACHED-END$' "$out"; then
    fail "$what :: $(grep -m 1 -E 'ERROR|FATAL' "$TMP/guard41u.err" | cut -c 1-200)"
  elif ! grep -q '^ROLLED-BACK$' "$out"; then
    fail "$what :: it ran to its end but boreholes still has org_id"
  else
    pass "$what"
  fi
  if [ "$(psql -X -q -At -c "$intact" 2>/dev/null)" = "1" ]; then
    pass "[c41] ... and, undone, the database is as it was"
  else
    fail "[c41] ... and, undone, the database is as it was :: tenancy objects or the mark are missing, or the test's rows were left behind"
  fi
}

# Criterion 48 (RF-091): the Drill rollback refuses when a non-founding
# organization WITHOUT members still holds a record row (each of the four
# tables on its own, also when the founding organization holds none) or a
# photo under its folder; and it still runs when a second organization exists
# and holds nothing. guards/c48_fixture.sql builds each state inside a
# transaction that is never committed.
rollback_refuses_c48() {
  local out="$TMP/guard48.out" rc what empty label name
  local intact="select (to_regclass('public.organizations') is not null and exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped) and not exists (select 1 from public.organizations where name = 'Second company (no members)') and not exists (select 1 from auth.users where email like 'guard48-%@db-test.invalid') and not exists (select 1 from storage.objects where name like '%7e57da7a-0000-4000-8000-0000000000c_/%'))::int"

  for what in boreholes pipe_records drilling_events shift_logs photo; do
    for empty in 0 1; do
      case "$what" in
        photo) label="a photo is stored under the folder of a non-founding organization that has no members and no records" ;;
        boreholes) label="a non-founding organization that has no members holds a borehole" ;;
        *) case "$empty" in
             1) label="a non-founding organization that has no members holds a borehole and a row of $what" ;;
             *) label="a non-founding organization that has no members holds a row of $what, under a borehole of the founding organization" ;;
           esac ;;
      esac
      case "$empty" in
        1) label="$label, and the founding organization holds no record at all" ;;
        *) label="$label (the founding organization holds records too)" ;;
      esac
      name="[c48] the Drill rollback refuses when $label"
      psql -X -q -At -v ON_ERROR_STOP=1 -v rollback_drill="$RB_DRILL_NEWEST_FIRST" -v what="$what" -v founding_empty="$empty" \
        -f "$HERE/guards/rollback_refuses_c48.sql" >"$out" 2>"$TMP/guard48.err"
      rc=$?
      if ! grep -q '^FIXTURE-READY$' "$out"; then
        fail "$name :: not checked, the fixture did not load: $(grep -m 1 -E 'ERROR|FATAL' "$TMP/guard48.err" | cut -c 1-200)"
      elif grep -q '^REACHED-END$' "$out" || [ "$rc" -eq 0 ]; then
        fail "$name :: the script ran to its end without raising"
      elif ! grep -q -i 'refus' "$TMP/guard48.err"; then
        fail "$name :: it stopped, but not by refusing: $(grep -m 1 -E 'ERROR|FATAL' "$TMP/guard48.err" | cut -c 1-200)"
      else
        pass "$name"
      fi
    done
  done

  name="[c48] the Drill rollback still runs when a second organization exists and everything stored belongs to the founding one (records in all four tables, a photo under its folder, a legacy photo)"
  psql -X -q -At -v ON_ERROR_STOP=1 -v rollback_drill="$RB_DRILL_NEWEST_FIRST" -v what="nothing" -v founding_empty="0" \
    -f "$HERE/guards/rollback_refuses_c48.sql" >"$out" 2>"$TMP/guard48.err"
  rc=$?
  if ! grep -q '^FIXTURE-READY$' "$out"; then
    fail "$name :: not checked, the fixture did not load: $(grep -m 1 -E 'ERROR|FATAL' "$TMP/guard48.err" | cut -c 1-200)"
  elif [ "$rc" -ne 0 ] || ! grep -q '^REACHED-END$' "$out"; then
    fail "$name :: $(grep -m 1 -E 'ERROR|FATAL' "$TMP/guard48.err" | cut -c 1-200)"
  elif ! grep -q '^ROLLED-BACK$' "$out"; then
    fail "$name :: it ran to its end but boreholes still has org_id"
  else
    pass "$name"
  fi

  # Every case ran inside a transaction that psql abandoned or rolled back.
  if [ "$(psql -X -q -At -c "$intact" 2>/dev/null)" = "1" ]; then
    pass "[c48] ... and after all eleven cases the database is as it was"
  else
    fail "[c48] ... and after all eleven cases the database is as it was :: tenancy objects are missing or the test's rows were left behind"
  fi
}

# Criterion 48 and decision 41, added in the validation of b548412: the clauses
# of the rollback guard that no check above pins (guards/rollback_guard_more.sql
# says which, and what state each case builds). Every case runs inside a
# transaction that is never committed.
rollback_guard_more() {
  local out="$TMP/guard51.out" rc c name
  local intact="select (to_regclass('public.organizations') is not null and exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped) and (select count(*) from public.organizations where is_founding) = 1 and not exists (select 1 from public.organizations where name = 'Second company (guard, more)') and not exists (select 1 from auth.users where email like 'guard51-%@db-test.invalid') and not exists (select 1 from storage.objects where name ilike '%7e57da7a-0000-4000-8000-0000000000f_/%'))::int"

  for c in photo_upper unflagged_record unflagged_photo lone_member lone_record lone_photo; do
    case "$c" in
      photo_upper)      name="[c48] the Drill rollback refuses when the photo of a memberless non-founding organization sits under its folder spelled in upper case" ;;
      unflagged_record) name="[c48] the Drill rollback refuses when no organization is marked founding and a second organization without members holds a borehole" ;;
      unflagged_photo)  name="[c48] the Drill rollback refuses when no organization is marked founding and a second organization without members holds a photo" ;;
      lone_member)      name="[c41] the Drill rollback refuses when the founding organization holds nothing at all and another organization has a (deactivated) member" ;;
      lone_record)      name="[c48] the Drill rollback refuses when the founding organization holds nothing at all and another organization holds a borehole" ;;
      lone_photo)       name="[c48] the Drill rollback refuses when the founding organization holds nothing at all and another organization holds a photo" ;;
    esac
    psql -X -q -At -v ON_ERROR_STOP=1 -v rollback_drill="$RB_DRILL_NEWEST_FIRST" -v case="$c" \
      -f "$HERE/guards/rollback_guard_more.sql" >"$out" 2>"$TMP/guard51.err"
    rc=$?
    if ! grep -q '^FIXTURE-READY$' "$out"; then
      fail "$name :: not checked, the fixture did not load: $(grep -m 1 -E 'ERROR|FATAL' "$TMP/guard51.err" | cut -c 1-200)"
    elif grep -q '^REACHED-END$' "$out" || [ "$rc" -eq 0 ]; then
      fail "$name :: the script ran to its end without raising"
    elif ! grep -q -i 'refusing to roll back' "$TMP/guard51.err"; then
      fail "$name :: it stopped, but not by refusing: $(grep -m 1 -E 'ERROR|FATAL' "$TMP/guard51.err" | cut -c 1-200)"
    else
      pass "$name"
    fi
  done

  name="[c48] (Developer's reading) with no organization marked founding and everything (members, a borehole, a photo under its folder, a legacy photo) in one organization, the Drill rollback runs although a second, empty organization exists"
  psql -X -q -At -v ON_ERROR_STOP=1 -v rollback_drill="$RB_DRILL_NEWEST_FIRST" -v case="unflagged_one" \
    -f "$HERE/guards/rollback_guard_more.sql" >"$out" 2>"$TMP/guard51.err"
  rc=$?
  if ! grep -q '^FIXTURE-READY$' "$out"; then
    fail "$name :: not checked, the fixture did not load: $(grep -m 1 -E 'ERROR|FATAL' "$TMP/guard51.err" | cut -c 1-200)"
  elif [ "$rc" -ne 0 ] || ! grep -q '^REACHED-END$' "$out"; then
    fail "$name :: $(grep -m 1 -E 'ERROR|FATAL' "$TMP/guard51.err" | cut -c 1-200)"
  elif ! grep -q '^ROLLED-BACK$' "$out"; then
    fail "$name :: it ran to its end but boreholes still has org_id"
  else
    pass "$name"
  fi

  if [ "$(psql -X -q -At -c "$intact" 2>/dev/null)" = "1" ]; then
    pass "[c48] ... and after those seven cases the database is as it was"
  else
    fail "[c48] ... and after those seven cases the database is as it was :: tenancy objects or the mark are missing, or the test's rows were left behind"
  fi
}

# Criterion 53 (RF-098): the Drill rollback also refuses when a stored photo
# has the shape of the new path (<uuid>/<uuid>/...) and its first segment is
# the id of NO organization (the organization's row was deleted), in either
# case of the letters; legacy paths (<user id>/<file>) never stop it.
# guards/rollback_refuses_c53.sql says what state each case builds. Every case
# runs inside a transaction that is never committed.
rollback_refuses_c53() {
  local out="$TMP/guard53.out" rc c name
  local intact="select (to_regclass('public.organizations') is not null and exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped) and (select count(*) from public.organizations where is_founding) = 1 and not exists (select 1 from auth.users where email like 'guard53-%@db-test.invalid') and not exists (select 1 from public.boreholes where name = 'founding company hole (guard 53)') and not exists (select 1 from storage.objects where name ilike '%7e57da7a-0000-4000-8000-0000000053%'))::int"

  for c in orphan orphan_upper orphan_deep; do
    case "$c" in
      orphan)       name="[c53] the Drill rollback refuses when a photo is stored at <uuid>/<uuid>/<file> and its first segment is the id of no organization" ;;
      orphan_upper) name="[c53] the Drill rollback refuses when a photo is stored at <UUID>/<uuid>/<file>, the first segment in upper case and the id of no organization" ;;
      orphan_deep)  name="[c53] the Drill rollback refuses when a photo is stored at <uuid>/<uuid>/a/b/<file> and its first segment is the id of no organization" ;;
    esac
    psql -X -q -At -v ON_ERROR_STOP=1 -v rollback_drill="$RB_DRILL_NEWEST_FIRST" -v case="$c" \
      -f "$HERE/guards/rollback_refuses_c53.sql" >"$out" 2>"$TMP/guard53.err"
    rc=$?
    if ! grep -q '^FIXTURE-READY$' "$out"; then
      fail "$name :: not checked, the fixture did not load: $(grep -m 1 -E 'ERROR|FATAL' "$TMP/guard53.err" | cut -c 1-200)"
    elif grep -q '^REACHED-END$' "$out" || [ "$rc" -eq 0 ]; then
      fail "$name :: the script ran to its end without raising"
    elif ! grep -q -i 'refus' "$TMP/guard53.err"; then
      fail "$name :: it stopped, but not by refusing: $(grep -m 1 -E 'ERROR|FATAL' "$TMP/guard53.err" | cut -c 1-200)"
    else
      pass "$name"
    fi
  done

  for c in legacy founding_upper; do
    case "$c" in
      legacy)         name="[c53] the Drill rollback still runs when the only photos are legacy paths <user id>/<file> (of a member, of an account that no longer exists, one whose file name is a uuid) and a new-path photo under the founding organization" ;;
      founding_upper) name="[c53] the Drill rollback still runs when the only photo is a new-path photo under the founding organization's id spelled in upper case" ;;
    esac
    psql -X -q -At -v ON_ERROR_STOP=1 -v rollback_drill="$RB_DRILL_NEWEST_FIRST" -v case="$c" \
      -f "$HERE/guards/rollback_refuses_c53.sql" >"$out" 2>"$TMP/guard53.err"
    rc=$?
    if ! grep -q '^FIXTURE-READY$' "$out"; then
      fail "$name :: not checked, the fixture did not load: $(grep -m 1 -E 'ERROR|FATAL' "$TMP/guard53.err" | cut -c 1-200)"
    elif [ "$rc" -ne 0 ] || ! grep -q '^REACHED-END$' "$out"; then
      fail "$name :: $(grep -m 1 -E 'ERROR|FATAL' "$TMP/guard53.err" | cut -c 1-200)"
    elif ! grep -q '^ROLLED-BACK$' "$out"; then
      fail "$name :: it ran to its end but boreholes still has org_id"
    else
      pass "$name"
    fi
  done

  # Every case ran inside a transaction that psql abandoned or rolled back.
  if [ "$(psql -X -q -At -c "$intact" 2>/dev/null)" = "1" ]; then
    pass "[c53] ... and after those five cases the database is as it was"
  else
    fail "[c53] ... and after those five cases the database is as it was :: tenancy objects or the mark are missing, or the test's rows were left behind"
  fi
}

# Decision 44: what the "cannot tell which organization is the founding one"
# error tells the operator. $1 is psql's error output, $2 the check's name.
# Everything the server sent counts (message, detail, hint); only the wording
# needed to tell "add the column" from "set the column" is looked for: the
# column's name, and an instruction to add it (ALTER TABLE ... ADD COLUMN, or
# the words "add ... column").
founding_message_says_add() {
  grep -v '^CONTEXT:' "$1" | tr '\n' ' ' | grep -q 'is_founding' \
    && grep -v '^CONTEXT:' "$1" | tr '\n' ' ' | grep -q -i -E '(add[[:space:]]+column|add[[:space:]]+(the|a|this)[[:space:]]+([a-z_]+[[:space:]]+)?column|alter[[:space:]]+table[^;]*[[:space:]]add[[:space:]])'
}
founding_message_check() {
  local err="$1" what="$2"
  if ! grep -q -i 'founding' "$err"; then
    fail "$what :: not checked, the migration did not stop on the founding organization"
  elif founding_message_says_add "$err"; then
    pass "$what"
  else
    fail "$what :: the message is: $(grep -m 1 -E 'ERROR' "$err" | sed 's/^psql:[^ ]* //' | cut -c 1-260)"
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
  # Decision 44 (RF-084): on a real first application the failed transaction
  # takes the flag column away again, so "set the flag" alone cannot be
  # followed. The message must say how to ADD the column as well. (local.sh
  # follows the instructions on a database in exactly that state.)
  founding_message_check "$TMP/first.err" "[c44] the message for an undecidable founding organization says how to add the flag column, not only to set it"
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
    86_reapply_after_drill_rollback.sql)
      if [ "$ready" -eq 1 ]; then run_file "$f"; else fail "[c39] re-application after the Drill rollback alone not tried :: see the transaction-control checks above"; fi
      ;;
    87_reapply_first_application.sql)
      if [ "$ready" -eq 1 ]; then run_file "$f"; else fail "[c39][c45][c46] first and plain re-applications not tried :: see the transaction-control checks above"; fi
      ;;
    90_rollback_in_transaction.sql)
      if [ "$ready" -eq 1 ]; then
        rollback_refuses
        rollback_refuses_members
        rollback_unflagged
        rollback_refuses_c48
        rollback_guard_more
        rollback_refuses_c53
        run_file "$f"
      else
        fail "[c31] rollback refusal not tried :: see the transaction-control checks above"
        fail "[c48] rollback refusal for a memberless organization's records and photos not tried :: see the transaction-control checks above"
        fail "[c48] the further cases of the rollback guard not tried :: see the transaction-control checks above"
        fail "[c53] rollback refusal for a photo under the folder of an organization that no longer exists not tried :: see the transaction-control checks above"
        fail "[c14] rollback rehearsal not run :: see the transaction-control checks above"
      fi
      ;;
    95_members_rollback.sql)
      if [ "$ready" -eq 1 ] && [ "$ready_members" -eq 1 ]; then
        run_file "$f"
      else
        fail "[P2-1 c13] rollback of the member migrations not tried :: a migration or rollback file is missing or contains transaction control, see the checks above"
        fail "[P2-1] second application of the member migrations not tried :: see the checks above"
      fi
      ;;
    *) run_file "$f" ;;
  esac
done

# 6. P2-1 criterion 4. Last, and outside any test file: it needs two sessions
#    and committed rows, which it removes.
members_concurrency

echo "# ${LABEL}total: $total checks, $passed passed, $failed failed"
[ "$failed" -eq 0 ]
