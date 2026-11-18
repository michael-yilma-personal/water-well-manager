#!/usr/bin/env bash
#
# The database tests on a machine with no Docker.
#
#   supabase/tests/local.sh            everything
#   KEEP=1 supabase/tests/local.sh     leave the scratch cluster's files behind
#                                      (stopped) and print where they are
#
# Builds a throwaway PostgreSQL cluster in a temporary directory, reachable
# only through a Unix socket inside that directory (no TCP port is opened, no
# system service is touched), loads a hand-written STAND-IN for what Supabase
# provides (stub/supabase_stub.sql), and removes everything afterwards.
# Needs initdb, pg_ctl, postgres and psql on PATH (Homebrew postgresql).
#
# CI runs supabase/tests/run.sh against Supabase's own Postgres image and is
# the authority; this script exists so the same tests, and three things CI's
# single empty database cannot show, run before a push:
#
# The fresh and upgrade phases run twice, once per "world" the stand-in can
# model (stub/supabase_stub.sql): bare, where the API roles get nothing by
# default on tables in public (Supabase's local image, so CI), and hosted,
# where they get everything (production, staging). Criterion 25 requires the
# same explicit privileges from either start. The core phase runs bare.
#
#   fresh     stub + every migration, then run.sh (the suite CI runs).
#   upgrade   stub + the pre-tenancy migrations, legacy data (accounts, a
#             banned one, records, a photo), THEN the tenancy migrations:
#             founding organization, memberships and org_id backfill (criteria
#             6, 7); the whole suite again on top of that data; then the
#             rollback scripts (criterion 14). Hosted: the catalog and the
#             data must equal what was there before, and the installed
#             build's behaviour must be back. Bare: the scripts run, what the
#             migrations added is gone and the data is intact.
#   core      stub + saas_core alone, applied twice (criterion 4), with nothing
#             of Drill's in the database (section A, criterion 2's default).
#   statement by statement (hosted)
#             the Drill migration applied one statement per transaction on
#             legacy data, with an installed build's inserts (the four record
#             tables and a photo upload) tried after each statement, and an
#             account created after each statement tried once the migration
#             is through (decision 29). Also after each statement: accounts
#             are created, banned, unbanned and re-roled, and once the
#             migration is through each founding membership must say so
#             (decision 39).
#   rollback guard (hosted)
#             the Drill rollback against two organizations that both hold
#             records: it must raise and change nothing (decision 31).
#   rollback guard, members only (hosted)
#             the same against a second organization that has a membership
#             and no records (decision 41).
#   saas_core, statement by statement (hosted)
#             saas_core applied one statement per transaction on a database
#             with the hosted default grants; after each statement anon and
#             authenticated try to insert, update and delete in every
#             foundation table that exists by then (decision 42).
#   undecidable founding organization (hosted)
#             a first application of the Drill migration with two
#             organizations: the error's instructions are followed on the
#             database the failed application leaves (decision 44).
#   in flight (hosted)
#             the Drill migration on legacy data while accounts are being
#             created, re-roled, banned and unbanned in transactions that are
#             still OPEN when a statement runs and commit after it
#             (lib/in_flight.py): once statement by statement, once as one
#             transaction. Every such account must end with the founding
#             membership the legacy tables describe (decision 39).
#   in flight, re-application and marked by hand (hosted)
#             the same with the two other kinds of first application: the
#             migration applied again after the Drill rollback alone (every
#             account still has its membership), and applied for the first
#             time with the founding organization marked by hand.
#   rollback, statement by statement (hosted)
#             the Drill ROLLBACK applied one statement per transaction on a
#             migrated database with legacy data. Before the first statement
#             and after every one (upgrade/rollback_window_probe.sql): a
#             signed-in user tries to change their own profiles.role, and an
#             installed build's inserts, upserts, reads and photo upload are
#             tried, also as an account created at that moment and as a
#             banned one reactivated at that moment; none may fail with an
#             error it fails with neither before the rollback nor after it
#             (criterion 47). Then the result must
#             be the pre-tenancy database, as after a rollback in one piece.
#   rollback guard, no members (hosted)
#             the Drill rollback against a second organization that has NO
#             members but still holds one record row (each of the four
#             tables, with and without records in the founding organization)
#             or a photo under its folder: it must raise and change nothing.
#             With everything in the founding organization it runs
#             (criterion 48).
#   first application, second organization (hosted)
#             a first application of the Drill migration when two legacy
#             accounts already belong to a second organization only: they get
#             no founding membership; the accounts with no membership
#             anywhere are enrolled (criterion 49).
#
# Output and exit status are as for run.sh: one line per check, a total,
# non-zero when anything failed.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# See run.sh: for trying the tests against scratch migrations only.
SUPA="${DRILL_TEST_SUPABASE_DIR:-$ROOT/supabase}"
MIGRATIONS="$SUPA/migrations"

# The tenancy migrations and their rollback scripts. Everything that sorts
# before the first is "pre-tenancy".
FIRST_TENANCY="20261116000000"
MIG_CORE="$MIGRATIONS/20261116000000_saas_core.sql"
MIG_DRILL="$MIGRATIONS/20261116010000_drill_tenancy.sql"
RB_CORE="$SUPA/rollback/20261116000000_saas_core.sql"
RB_DRILL="$SUPA/rollback/20261116010000_drill_tenancy.sql"

for tool in initdb pg_ctl postgres psql python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "local.sh: $tool is not on PATH (brew install postgresql@17)." >&2; exit 2; }
done

# --- Scratch cluster ----------------------------------------------------------

# Never the default port, so nothing here can be mistaken for a real server.
PORT="${DRILL_TEST_PGPORT:-54329}"
[ "$PORT" != "5432" ] || { echo "local.sh: refusing the default port 5432." >&2; exit 2; }

# A Unix socket path is limited to about 100 bytes; fall back to /tmp when the
# session's temporary directory is too deep.
BASE="${TMPDIR:-/tmp}"
BASE="${BASE%/}"
if [ "$(printf '%s' "$BASE/drill-pgtest.XXXXXX/s/.s.PGSQL.$PORT" | wc -c)" -gt 100 ]; then
  BASE="/tmp"
fi
WORK="$(mktemp -d "$BASE/drill-pgtest.XXXXXX")" || exit 2
DATA="$WORK/data"
SOCK="$WORK/s"
mkdir -p "$SOCK"

cleanup() {
  if [ -f "$DATA/postmaster.pid" ]; then
    pg_ctl -D "$DATA" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if [ "${KEEP:-0}" = "1" ]; then
    echo "# scratch cluster kept (stopped) in $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

if ! initdb -D "$DATA" -U postgres -A trust -E UTF8 --locale=C --no-sync >"$WORK/initdb.log" 2>&1; then
  echo "local.sh: initdb failed:" >&2
  cat "$WORK/initdb.log" >&2
  exit 2
fi

# listen_addresses='' : no TCP at all. The socket directory is private (0700).
if ! pg_ctl -D "$DATA" -l "$WORK/server.log" -w start \
      -o "-c listen_addresses='' -c unix_socket_directories='$SOCK' -c unix_socket_permissions=0700 -c port=$PORT -c fsync=off -c max_connections=20" \
      >"$WORK/pg_ctl.log" 2>&1; then
  echo "local.sh: the scratch server did not start:" >&2
  cat "$WORK/pg_ctl.log" "$WORK/server.log" >&2 2>/dev/null
  exit 2
fi

# Everything below talks to the scratch cluster and nothing else.
unset PGSERVICE PGHOSTADDR PGPASSWORD PGDATABASE PGOPTIONS
export PGHOST="$SOCK" PGPORT="$PORT" PGUSER="postgres"

# --- Counting -----------------------------------------------------------------

total=0
passed=0
failed=0
PHASE=""

pass() { total=$((total + 1)); passed=$((passed + 1)); echo "ok - [$PHASE] $1"; }
fail() { total=$((total + 1)); failed=$((failed + 1)); echo "FAIL - [$PHASE] $1"; }

# Run run.sh against a database and add its totals to ours.
suite() {
  local db="$1" line
  shift
  local log="$WORK/suite.log"
  PGDATABASE="$db" RUN_LABEL="$PHASE" "$HERE/run.sh" "$@" | tee "$log" | grep -v '^# .*total: '
  line="$(grep '^# .*total: ' "$log" | tail -n 1)"
  if [ -z "$line" ]; then
    fail "run.sh printed no total against database $db"
    return
  fi
  local t p f
  t="$(printf '%s' "$line" | sed -n 's/.*total: \([0-9]*\) checks, \([0-9]*\) passed, \([0-9]*\) failed.*/\1/p')"
  p="$(printf '%s' "$line" | sed -n 's/.*total: \([0-9]*\) checks, \([0-9]*\) passed, \([0-9]*\) failed.*/\2/p')"
  f="$(printf '%s' "$line" | sed -n 's/.*total: \([0-9]*\) checks, \([0-9]*\) passed, \([0-9]*\) failed.*/\3/p')"
  total=$((total + t)); passed=$((passed + p)); failed=$((failed + f))
}

new_db() {
  psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "create database \"$1\"" >/dev/null
}

# Apply one SQL file as a single transaction, the way a migration is applied.
# Prints the first error on failure.
apply() {
  local db="$1" file="$2"
  psql -X -q -v ON_ERROR_STOP=1 -1 -d "$db" -f "$file" >/dev/null 2>"$WORK/apply.err"
}
first_error() { grep -m 1 -E 'ERROR|FATAL|error' "$WORK/apply.err" | sed 's/^psql:[^ ]* //'; }

apply_checked() {
  local db="$1" file="$2" what="$3"
  if [ ! -f "$file" ]; then
    fail "$what :: supabase/${file#"$SUPA"/} is missing"
    return 1
  fi
  if apply "$db" "$file"; then
    pass "$what"
  else
    fail "$what :: $(first_error)"
    return 1
  fi
}

pre_tenancy_migrations() {
  for f in "$MIGRATIONS"/*.sql; do
    [ "$(basename "$f")" \< "$FIRST_TENANCY" ] && echo "$f"
  done
}
all_migrations() {
  for f in "$MIGRATIONS"/*.sql; do echo "$f"; done
}

snapshot() { psql -X -q -At -v ON_ERROR_STOP=1 -d "$1" -f "$HERE/lib/snapshot.sql" >"$2" 2>"$WORK/snap.err"; }
touched()  { psql -X -q -At -v ON_ERROR_STOP=1 -d "$1" -f "$HERE/upgrade/modified_at_digest.sql" >"$2" 2>"$WORK/touched.err"; }
digest()   { psql -X -q -At -v ON_ERROR_STOP=1 -d "$1" -f "$HERE/upgrade/data_digest.sql" >"$2" 2>"$WORK/digest.err"; }

# Compare one section of two snapshots.
same_section() {
  local section="$1" before="$2" after="$3" what="$4" d
  if [ ! -s "$before" ] || [ ! -s "$after" ]; then
    fail "$what :: not checked, a snapshot is missing or empty"
    return
  fi
  d="$(diff <(grep "^$section|" "$before") <(grep "^$section|" "$after"))"
  if [ -z "$d" ]; then
    pass "$what"
  else
    fail "$what :: $(printf '%s' "$d" | grep '^[<>]' | head -n 4 | cut -c 1-300 | tr '\n' ';')"
  fi
}

SECTIONS="tables columns constraints indexes policies functions triggers grants column_grants buckets"

# Load the stand-in in one of its two worlds (see stub/supabase_stub.sql).
load_stub() {
  local db="$1" world="$2"
  psql -X -q -v ON_ERROR_STOP=1 -v world="$world" -1 -d "$db" -f "$HERE/stub/supabase_stub.sql" >/dev/null 2>"$WORK/apply.err"
}

# --- fresh: stub + every migration, then the suite CI runs --------------------

phase_fresh() {
  local world="$1" db="fresh_$1" f
  PHASE="$world, fresh"
  new_db "$db"
  if load_stub "$db" "$world"; then
    pass "[harness] the Supabase stand-in loads into an empty database ($world world)"
  else
    fail "[harness] the Supabase stand-in loads into an empty database ($world world) :: $(first_error)"
  fi
  while IFS= read -r f; do
    if [ "$(basename "$f")" \< "$FIRST_TENANCY" ]; then
      apply_checked "$db" "$f" "[harness] pre-tenancy migration $(basename "$f") applies on the stand-in"
    else
      apply_checked "$db" "$f" "[c4] $(basename "$f") applies to a database with no data"
    fi
  done < <(all_migrations)
  suite "$db"
}

# --- upgrade: legacy data first, then the tenancy migrations, then rollback ---

phase_upgrade() {
  local world="$1" db="upgrade_$1" f d s tbl what migrated rolled_back
  PHASE="$world, upgrade"
  new_db "$db"
  load_stub "$db" "$world" || fail "[harness] the Supabase stand-in loads :: $(first_error)"
  while IFS= read -r f; do
    apply "$db" "$f" || fail "[harness] $(basename "$f") applies :: $(first_error)"
  done < <(pre_tenancy_migrations)
  apply_checked "$db" "$HERE/upgrade/seed_legacy.sql" "[harness] legacy accounts, records and a photo are loaded before the tenancy migrations"

  rm -f "$WORK"/snap.before "$WORK"/snap.after "$WORK"/digest.* "$WORK"/touched.*
  snapshot "$db" "$WORK/snap.before" || fail "[harness] catalog snapshot before the migrations :: $(head -n 1 "$WORK/snap.err")"
  digest "$db" "$WORK/digest.before" || fail "[harness] data digest before the migrations :: $(head -n 1 "$WORK/digest.err")"
  touched "$db" "$WORK/touched.before" || fail "[harness] modified_at digest before the migrations :: $(head -n 1 "$WORK/touched.err")"

  migrated=1
  apply_checked "$db" "$MIG_CORE"  "[c6] saas_core applies on top of existing data" || migrated=0
  apply_checked "$db" "$MIG_DRILL" "[c6][c7] drill_tenancy applies on top of existing data" || migrated=0

  suite "$db" "$HERE/upgrade/after_migration.sql"

  what="[c7] the migration kept every existing row, account and photo unchanged (org_id aside)"
  if [ "$migrated" -eq 1 ] && digest "$db" "$WORK/digest.after"; then
    d="$(diff "$WORK/digest.before" "$WORK/digest.after")"
    if [ -z "$d" ]; then pass "$what"; else fail "$what :: $(printf '%s' "$d" | grep '^[<>]' | tr '\n' ';')"; fi
  else
    fail "$what :: not checked, the migrations did not apply"
  fi

  # Criterion 21, per table. The seed and the migration run in separate
  # transactions, so a backfill that fires the touch trigger shows as a new hash.
  for tbl in boreholes pipe_records drilling_events shift_logs; do
    what="[c21] the backfill left modified_at untouched on every existing row of $tbl"
    if [ "$migrated" -eq 1 ] && [ -s "$WORK/touched.before" ] && touched "$db" "$WORK/touched.after"; then
      if [ "$(grep "^$tbl|" "$WORK/touched.before")" = "$(grep "^$tbl|" "$WORK/touched.after")" ] && grep -q "^$tbl|[1-9]" "$WORK/touched.before"; then
        pass "$what"
      else
        fail "$what :: before $(grep "^$tbl|" "$WORK/touched.before"), after $(grep "^$tbl|" "$WORK/touched.after")"
      fi
    else
      fail "$what :: not checked, the migrations did not apply"
    fi
  done

  # The whole suite again, now with the legacy data underneath it.
  PHASE="$world, upgrade, full suite"
  suite "$db"
  PHASE="$world, upgrade"

  # Criterion 14. Checking the state after a rollback proves nothing unless
  # the migrations were really applied and the rollback scripts really ran.
  rolled_back=1
  if [ "$migrated" -eq 1 ]; then
    apply_checked "$db" "$RB_DRILL" "[c14] the drill_tenancy rollback script runs on the migrated database with its data" || rolled_back=0
    apply_checked "$db" "$RB_CORE"  "[c14] the saas_core rollback script runs after it" || rolled_back=0
  else
    fail "[c14] the rollback scripts run on the migrated database :: not run, the migrations did not apply"
    rolled_back=0
  fi

  what="[c14] after rollback, every row, account and photo that existed before is still there, unchanged"
  if [ "$rolled_back" -eq 1 ] && digest "$db" "$WORK/digest.rolledback"; then
    d="$(diff "$WORK/digest.before" "$WORK/digest.rolledback")"
    if [ -z "$d" ]; then pass "$what"; else fail "$what :: $(printf '%s' "$d" | grep '^[<>]' | tr '\n' ';')"; fi
  else
    fail "$what :: not checked, there was no rollback to check"
  fi

  if [ "$world" = "hosted" ]; then
    # The starting point production has. A rollback must put back exactly
    # that: every policy, column, function, trigger and grant, and with them
    # the installed build's behaviour.
    if [ "$rolled_back" -eq 1 ] && snapshot "$db" "$WORK/snap.after"; then
      for s in $SECTIONS; do
        same_section "$s" "$WORK/snap.before" "$WORK/snap.after" "[c14] after rollback, the $s are exactly what they were before the migrations"
      done
      suite "$db" "$HERE/sql/05_legacy_client.sql"
    else
      for s in $SECTIONS; do
        fail "[c14] after rollback, the $s are exactly what they were before the migrations :: not checked, there was no rollback to check"
      done
      fail "[c14] after rollback, the installed build's behaviour is back :: not checked, there was no rollback to check"
    fi
  else
    # A bare start had no privileges for the API roles, so there is no working
    # earlier state to return to and none is required: only that the scripts
    # run and what the migrations added is gone.
    if [ "$rolled_back" -eq 1 ]; then
      suite "$db" "$HERE/upgrade/after_rollback_gone.sql"
    else
      fail "[c14] after rollback, what the tenancy migrations added is gone :: not checked, there was no rollback to check"
    fi
  fi
}

# Bare first: it is what CI sees.
for WORLD in bare hosted; do
  phase_fresh "$WORLD"
  phase_upgrade "$WORLD"
done

# --- statement by statement: decision 29 ---------------------------------------
#
# local.sh applies a migration the way `psql -1` does, all or nothing. If the
# tool that applies it to a real project ever does not, clients keep writing
# while the Drill migration is half done. This phase applies it one statement
# per transaction on a database holding legacy data and, after every
# statement, tries what an installed build does (upgrade/window_probe.sql).

C39_BAN_NEW="[c39] an account created and banned between any two statements ends with a deactivated founding membership"
C39_ROLE_NEW="[c39] an account created and re-roled between any two statements ends with that role and badge in its founding membership"
C39_BAN_OLD="[c39] an existing account banned between any two statements ends with a deactivated founding membership"
C39_ROLE_OLD="[c39] an existing account re-roled between any two statements ends with that role and badge in its founding membership"
C39_UNBAN_OLD="[c39] an existing banned account unbanned between any two statements ends with an active founding membership"

# Decision 39, one kind of account the probe acted on after every statement
# (upgrade/window_probe.sql). Every one of them must end with exactly the
# membership `expected` describes; `expected` is SQL over n, the statement's
# three-digit number.
#   c39_kind <db> <check name> <probe action> <address prefix> <expected> <statements>
c39_kind() {
  local db="$1" what="$2" action="$3" prefix="$4" expected="$5" stmts="$6" seen refused bad
  seen="$(psql -X -q -At -d "$db" -c "select count(*) from auth.users where email like '${prefix}-%@db-test.invalid'" 2>/dev/null)"
  refused="$(psql -X -q -At -d "$db" -c "select count(*) || ' time(s) the action itself failed (' || min(state) || ' ' || left(min(msg), 70) || '): after statements ' || string_agg(left(stmt, 3), ', ' order by stmt) from t_probe.results where tbl = '${action}' and state <> '00000' having count(*) > 0" 2>/dev/null)"
  bad="$(psql -X -q -At -d "$db" -c "select count(*) || ' of ' || (select count(*) from auth.users where email like '${prefix}-%@db-test.invalid') || ' end otherwise (for instance ' || min(got) || '): those of statements ' || string_agg(n, ', ' order by n) from (select substr(u.email, length('${prefix}') + 2, 3) as n, coalesce((select string_agg(format('%s/%s/%s', m.role, m.status, coalesce(m.badge_number, '-')), ' + ' order by m.org_id) from public.memberships m where m.user_id = u.id), 'no membership') as got from auth.users u where u.email like '${prefix}-%@db-test.invalid') x where got <> ${expected} having count(*) > 0" 2>"$WORK/c39.err")"
  if [ "${stmts:-0}" -lt 3 ] || [ "${seen:-0}" -ne "${stmts:-0}" ]; then
    fail "$what :: not checked, ${seen:-0} such account(s) for ${stmts:-0} statement(s)"
  elif [ -s "$WORK/c39.err" ]; then
    fail "$what :: not checked, the look at the memberships failed: $(head -n 1 "$WORK/c39.err")"
  elif [ -n "$refused" ]; then
    fail "$what :: $refused"
  elif [ -n "$bad" ]; then
    fail "$what :: $bad"
  else
    pass "$what (${seen} accounts)"
  fi
}

phase_statement_by_statement() {
  local db="stepwise" tbl n bad rc what f stmts
  PHASE="hosted, statement by statement"
  new_db "$db"
  load_stub "$db" hosted || fail "[harness] the Supabase stand-in loads :: $(first_error)"
  while IFS= read -r f; do
    apply "$db" "$f" || fail "[harness] $(basename "$f") applies :: $(first_error)"
  done < <(pre_tenancy_migrations)
  apply "$db" "$HERE/upgrade/seed_legacy.sql" || fail "[harness] the legacy data loads :: $(first_error)"

  if [ ! -f "$MIG_CORE" ] || [ ! -f "$MIG_DRILL" ] || ! command -v python3 >/dev/null 2>&1; then
    for what in "[c29] drill_tenancy applies one statement at a time" \
                "[c29] the states in between were looked at" \
                "[c29] boreholes: an installed build's insert (no org_id) succeeds after every statement, once the column exists" \
                "[c29] pipe_records: an installed build's insert (no org_id) succeeds after every statement, once the column exists" \
                "[c29] drilling_events: an installed build's insert (no org_id) succeeds after every statement, once the column exists" \
                "[c29] shift_logs: an installed build's insert (no org_id) succeeds after every statement, once the column exists" \
                "[c29] photo upload: an installed build's upload to <user_id>/<file> succeeds after every statement" \
                "[c29] read own borehole: the installed build still reads it after every statement" \
                "[c29] read own photo: the installed build still reads it after every statement" \
                "[c29] an account created between any two statements can insert (no org_id) once the migration is through" \
                "$C39_BAN_NEW" "$C39_ROLE_NEW" "$C39_BAN_OLD" "$C39_ROLE_OLD" "$C39_UNBAN_OLD"; do
      fail "$what :: not checked, a migration file or python3 is missing"
    done
    return
  fi
  apply "$db" "$MIG_CORE" || fail "[harness] saas_core applies :: $(first_error)"
  psql -X -q -v ON_ERROR_STOP=1 -d "$db" >/dev/null 2>&1 <<'SQL'
create schema t_probe;
create table t_probe.results (stmt text, tbl text, state text, msg text);
SQL
  python3 "$HERE/lib/sql_statements.py" probe-script "$MIG_DRILL" "$HERE/upgrade/window_probe.sql" >"$WORK/stepwise.sql"
  # Decision 39: three accounts per statement that exist BEFORE the migration
  # starts (one of them banned), for the probe to ban, re-role and unban.
  stmts="$(grep -c "^select set_config('drill.stmt'" "$WORK/stepwise.sql")"
  psql -X -q -v ON_ERROR_STOP=1 -v stmts="${stmts:-0}" -d "$db" >/dev/null 2>"$WORK/pool.err" <<'SQL'
insert into auth.users (id, email, banned_until)
  select md5('drill-db-test:pool-' || kind || ':' || i)::uuid,
         'pool-' || kind || '-' || to_char(i, 'FM000') || '@db-test.invalid',
         case when kind = 'unban' then now() + interval '876000 hours' end
  from generate_series(1, :stmts) i, unnest(array['ban', 'role', 'unban']) kind;
SQL
  [ -s "$WORK/pool.err" ] && fail "[harness] the accounts that exist before the migration are created :: $(head -n 1 "$WORK/pool.err")"
  psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$WORK/stepwise.sql" >/dev/null 2>"$WORK/apply.err"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "[c29] drill_tenancy applies one statement at a time"
  else
    fail "[c29] drill_tenancy applies one statement at a time :: $(first_error)"
  fi

  n="$(psql -X -q -At -d "$db" -c "select count(distinct stmt) from t_probe.results where tbl = 'boreholes'" 2>/dev/null)"
  if [ "${n:-0}" -ge 3 ]; then
    pass "[c29] the states in between were looked at (${n} of them from the moment boreholes.org_id exists)"
  else
    fail "[c29] the states in between were looked at :: only ${n:-0} probe(s) ran"
  fi

  for tbl in boreholes pipe_records drilling_events shift_logs "photo upload" "read own borehole" "read own photo"; do
    what="[c29] $tbl: an installed build's insert (no org_id) succeeds after every statement, once the column exists"
    case "$tbl" in
      "photo upload") what="[c29] photo upload: an installed build's upload to <user_id>/<file> succeeds after every statement" ;;
      "read own"*)    what="[c29] $tbl: the installed build still reads it after every statement" ;;
    esac
    seen="$(psql -X -q -At -d "$db" -c "select count(distinct stmt) from t_probe.results where tbl = '$tbl'" 2>/dev/null)"
    bad="$(psql -X -q -At -d "$db" -c "select count(*) || ' state(s) refuse it: ' || string_agg('after statement ' || stmt || ' -> ' || state || ' ' || left(coalesce(msg, ''), 70), '; ' order by stmt) from (select * from t_probe.results where tbl = '$tbl' and state <> '00000' order by stmt limit 40) x having count(*) > 0" 2>/dev/null)"
    if [ "${n:-0}" -lt 3 ] || [ "${seen:-0}" -lt 3 ]; then
      fail "$what :: not checked, the probe did not run (${seen:-0} state(s) seen)"
    elif [ -n "$bad" ]; then
      fail "$what :: $bad"
    else
      pass "$what"
    fi
  done

  # The accounts the probe created, one after each statement (the dashboard's
  # "add user" while the migration is half done). Whenever it was created, an
  # account must end up able to do what an installed build does: a borehole
  # sent without org_id. Tried as each of them now that the migration is
  # through; each attempt is undone.
  what="[c29] an account created between any two statements can insert (no org_id) once the migration is through"
  psql -X -q -v ON_ERROR_STOP=1 -d "$db" >/dev/null 2>"$WORK/accounts.err" <<'SQL'
create table t_probe.accounts (stmt text, state text, msg text);
do $accounts$
declare
  a record;
begin
  for a in select id, email from auth.users where email like 'window-%@db-test.invalid' order by email loop
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', a.id, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      insert into public.boreholes (id, name, created_by, recorded_at)
        values (gen_random_uuid(), 'probe', a.id, now());
      raise exception using errcode = 'TR001', message = 'undo';
    exception
      when sqlstate 'TR001' then
        insert into t_probe.accounts values (substr(a.email, 8, 3), '00000', null);
      when others then
        insert into t_probe.accounts values (substr(a.email, 8, 3), sqlstate, sqlerrm);
    end;
  end loop;
end
$accounts$;
SQL
  seen="$(psql -X -q -At -d "$db" -c "select count(*) from t_probe.accounts" 2>/dev/null)"
  bad="$(psql -X -q -At -d "$db" -c "select count(*) || ' of ' || (select count(*) from t_probe.accounts) || ' accounts are refused (' || min(state) || ' ' || left(min(msg), 60) || '): those created after statements ' || string_agg(stmt, ', ' order by stmt) from t_probe.accounts where state <> '00000' having count(*) > 0" 2>/dev/null)"
  if [ "${seen:-0}" -lt 3 ]; then
    fail "$what :: not checked, no such accounts were created: $(head -n 1 "$WORK/accounts.err" 2>/dev/null)"
  elif [ -n "$bad" ]; then
    fail "$what :: $bad"
  else
    pass "$what (${seen} accounts)"
  fi

  # Decision 39: what was done to accounts between statements has arrived.
  c39_kind "$db" "$C39_BAN_NEW"   "c39 ban new"        "wban"       "'Driller/deactivated/-'"        "$stmts"
  c39_kind "$db" "$C39_ROLE_NEW"  "c39 role new"       "wrole"      "'Supervisor/active/W-' || n"    "$stmts"
  c39_kind "$db" "$C39_BAN_OLD"   "c39 ban existing"   "pool-ban"   "'Driller/deactivated/-'"        "$stmts"
  c39_kind "$db" "$C39_ROLE_OLD"  "c39 role existing"  "pool-role"  "'Supervisor/active/P-' || n"    "$stmts"
  c39_kind "$db" "$C39_UNBAN_OLD" "c39 unban existing" "pool-unban" "'Driller/active/-'"             "$stmts"

  # The files below expect the legacy accounts and no others.
  psql -X -q -d "$db" -c "delete from auth.users where email ~ '^(window|wban|wrole|pool-ban|pool-role|pool-unban)-[0-9]+@db-test[.]invalid\$'" >/dev/null 2>&1

  # Applied this way the result must be the same working database.
  psql -X -q -d "$db" -c "drop schema t_probe cascade" >/dev/null 2>&1
  suite "$db" "$HERE/upgrade/after_migration.sql"
}

# --- rollback guard: decision 31 ------------------------------------------------
#
# With two organizations holding records, the Drill rollback must raise and
# change nothing: applied here one statement per transaction, so "nothing"
# does not lean on a surrounding transaction.

phase_rollback_guard() {
  local db="guard" f s rc ok=1
  PHASE="hosted, rollback guard"
  new_db "$db"
  load_stub "$db" hosted || { fail "[harness] the Supabase stand-in loads :: $(first_error)"; ok=0; }
  while IFS= read -r f; do
    apply "$db" "$f" || { fail "[harness] $(basename "$f") applies :: $(first_error)"; ok=0; }
  done < <(all_migrations)
  [ -f "$MIG_DRILL" ] && [ -f "$RB_DRILL" ] && [ -f "$RB_CORE" ] || ok=0
  apply "$db" "$HERE/guards/two_companies.sql" || { fail "[harness] two organizations with records are loaded :: $(first_error)"; ok=0; }
  rm -f "$WORK"/snap.before "$WORK"/snap.after
  snapshot "$db" "$WORK/snap.before" || ok=0

  if [ "$ok" -eq 1 ]; then
    psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$RB_DRILL" >/dev/null 2>"$WORK/apply.err"
    rc=$?
    if [ "$rc" -ne 0 ]; then
      pass "[c31] the Drill rollback raises when two organizations hold record rows"
    else
      fail "[c31] the Drill rollback raises when two organizations hold record rows :: it ran to its end"
    fi
    snapshot "$db" "$WORK/snap.after"
    for s in $SECTIONS; do
      same_section "$s" "$WORK/snap.before" "$WORK/snap.after" "[c31] ... and changed nothing, though applied one statement at a time: the $s"
    done
    if [ "$(psql -X -q -At -d "$db" -c "select count(distinct org_id) from public.boreholes" 2>/dev/null)" = "2" ]; then
      pass "[c31] ... and both organizations' records still carry their organization"
    else
      fail "[c31] ... and both organizations' records still carry their organization :: org_id is gone or changed"
    fi

    # One organization with records: as before.
    psql -X -q -d "$db" -c "delete from public.boreholes where org_id = '7e57da7a-0000-4000-8000-000000000002'" >/dev/null 2>&1
    apply_checked "$db" "$RB_DRILL" "[c31] with records in one organization only, the Drill rollback runs as before (a second, empty organization exists)"
    apply_checked "$db" "$RB_CORE"  "[c31] ... and the saas_core rollback after it"
  else
    fail "[c31] the Drill rollback raises when two organizations hold record rows :: not checked, the database could not be prepared"
    for s in $SECTIONS; do
      fail "[c31] ... and changed nothing, though applied one statement at a time: the $s :: not checked"
    done
    fail "[c31] ... and both organizations' records still carry their organization :: not checked"
    fail "[c31] with records in one organization only, the Drill rollback runs as before (a second, empty organization exists) :: not checked"
    fail "[c31] ... and the saas_core rollback after it :: not checked"
  fi
}

# --- rollback guard, members only: decision 41 ---------------------------------
#
# A second organization with a membership and no records. The Drill rollback
# must raise and change nothing: applied one statement per transaction, as
# above. With the membership gone (the organization stays, empty) it runs.

phase_rollback_guard_members() {
  local db="guard41" f s rc ok=1 before after
  local second="7e57da7a-0000-4000-8000-000000000004"
  local rows="select coalesce(md5(string_agg(x, '|' order by x)), 'none') from (select 'o:' || o::text as x from public.organizations o union all select 'm:' || m::text from public.memberships m) r"
  PHASE="hosted, rollback guard (members only)"
  new_db "$db"
  load_stub "$db" hosted || { fail "[harness] the Supabase stand-in loads :: $(first_error)"; ok=0; }
  while IFS= read -r f; do
    apply "$db" "$f" || { fail "[harness] $(basename "$f") applies :: $(first_error)"; ok=0; }
  done < <(all_migrations)
  [ -f "$MIG_DRILL" ] && [ -f "$RB_DRILL" ] && [ -f "$RB_CORE" ] || ok=0
  apply "$db" "$HERE/guards/second_company_member.sql" || { fail "[harness] a second organization with a membership and no records is loaded :: $(first_error)"; ok=0; }
  # The fixture is what the check assumes: one membership there, records in
  # exactly one organization, and that one is not the second.
  if [ "$(psql -X -q -At -d "$db" -c "select ((select count(*) from public.memberships where org_id = '$second') = 1 and (select count(distinct org_id) from public.boreholes) = 1 and not exists (select 1 from public.boreholes where org_id = '$second') and not exists (select 1 from public.pipe_records where org_id = '$second') and not exists (select 1 from public.drilling_events where org_id = '$second') and not exists (select 1 from public.shift_logs where org_id = '$second'))::int" 2>/dev/null)" != "1" ]; then
    fail "[harness] the second organization has one membership and no records"
    ok=0
  fi
  rm -f "$WORK"/snap.before "$WORK"/snap.after
  snapshot "$db" "$WORK/snap.before" || ok=0
  before="$(psql -X -q -At -d "$db" -c "$rows" 2>/dev/null)"

  if [ "$ok" -eq 1 ]; then
    psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$RB_DRILL" >/dev/null 2>"$WORK/apply.err"
    rc=$?
    if [ "$rc" -ne 0 ]; then
      pass "[c41] the Drill rollback raises when a non-founding organization has a membership (a deactivated one) but no records"
    else
      fail "[c41] the Drill rollback raises when a non-founding organization has a membership (a deactivated one) but no records :: it ran to its end"
    fi
    snapshot "$db" "$WORK/snap.after"
    for s in $SECTIONS; do
      same_section "$s" "$WORK/snap.before" "$WORK/snap.after" "[c41] ... and changed nothing, though applied one statement at a time: the $s"
    done
    after="$(psql -X -q -At -d "$db" -c "$rows" 2>/dev/null)"
    if [ -n "$before" ] && [ "$before" != "none" ] && [ "$before" = "$after" ]; then
      pass "[c41] ... and every organization and membership row is as it was"
    else
      fail "[c41] ... and every organization and membership row is as it was :: the rows changed, or a column of theirs is gone"
    fi

    # The organization stays, without its member: nothing left to refuse for.
    psql -X -q -d "$db" -c "delete from public.memberships where org_id = '$second'" >/dev/null 2>&1
    apply_checked "$db" "$RB_DRILL" "[c41] with that membership removed, the Drill rollback runs (the second organization still exists, empty)"
    apply_checked "$db" "$RB_CORE"  "[c41] ... and the saas_core rollback after it"
  else
    fail "[c41] the Drill rollback raises when a non-founding organization has a membership (a deactivated one) but no records :: not checked, the database could not be prepared"
    for s in $SECTIONS; do
      fail "[c41] ... and changed nothing, though applied one statement at a time: the $s :: not checked"
    done
    fail "[c41] ... and every organization and membership row is as it was :: not checked"
    fail "[c41] with that membership removed, the Drill rollback runs (the second organization still exists, empty) :: not checked"
    fail "[c41] ... and the saas_core rollback after it :: not checked"
  fi
}

# --- saas_core, statement by statement: decision 42 ----------------------------
#
# On a hosted project every table created in public is granted in full to anon
# and authenticated at once. Applied one statement per transaction, saas_core
# must leave no state in which either of them can write to a foundation table
# (core/core_window_probe.sql is the look taken after every statement).

CORE_TABLES="organizations memberships platform_admins audit_log"

phase_core_statement_by_statement() {
  local db="corestep" f rc n r verb tbl what seen bad ok=1
  PHASE="hosted, saas_core statement by statement"
  new_db "$db"
  load_stub "$db" hosted || { fail "[harness] the Supabase stand-in loads :: $(first_error)"; ok=0; }
  while IFS= read -r f; do
    apply "$db" "$f" || { fail "[harness] $(basename "$f") applies :: $(first_error)"; ok=0; }
  done < <(pre_tenancy_migrations)
  apply "$db" "$HERE/upgrade/seed_legacy.sql" || { fail "[harness] the legacy data loads :: $(first_error)"; ok=0; }
  [ -f "$MIG_CORE" ] || ok=0

  # The probe has something to find: in this world a table nobody has locked
  # down yet IS writable by a signed-out client.
  what="[harness] with the hosted default grants, a signed-out client can write to a new table in public until something stops it"
  if psql -X -q -v ON_ERROR_STOP=1 -d "$db" >/dev/null 2>"$WORK/control.err" <<'SQL'
create table public.zz_probe_control (name text);
do $$ begin perform set_config('role', 'anon', true); insert into public.zz_probe_control values ('x'); end $$;
drop table public.zz_probe_control;
SQL
  then pass "$what"; else fail "$what :: $(grep -m 1 ERROR "$WORK/control.err")"; ok=0; fi

  if [ "$ok" -ne 1 ]; then
    fail "[c42] saas_core applies one statement at a time :: not checked, the database could not be prepared or the migration is missing"
    fail "[c42] the states in between were looked at :: not checked"
    for r in anon authenticated; do for verb in insert update delete; do for tbl in $CORE_TABLES; do
      fail "[c42] $r cannot $verb in $tbl after any statement of saas_core :: not checked"
    done; done; done
    return
  fi

  psql -X -q -v ON_ERROR_STOP=1 -d "$db" >/dev/null 2>&1 <<'SQL'
create schema t_probe;
create table t_probe.results (stmt text, tbl text, state text, msg text);
SQL
  python3 "$HERE/lib/sql_statements.py" probe-script "$MIG_CORE" "$HERE/core/core_window_probe.sql" >"$WORK/corestep.sql"
  psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$WORK/corestep.sql" >/dev/null 2>"$WORK/apply.err"
  rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "[c42] saas_core applies one statement at a time"
  else
    fail "[c42] saas_core applies one statement at a time :: $(first_error)"
  fi

  n="$(psql -X -q -At -d "$db" -c "select count(distinct stmt) from t_probe.results" 2>/dev/null)"
  if [ "${n:-0}" -ge 3 ]; then
    pass "[c42] the states in between were looked at (${n} of them from the moment the first foundation table exists)"
  else
    fail "[c42] the states in between were looked at :: only ${n:-0} probe(s) ran"
  fi

  for r in anon authenticated; do for verb in insert update delete; do for tbl in $CORE_TABLES; do
    what="[c42] $r cannot $verb in $tbl after any statement of saas_core"
    seen="$(psql -X -q -At -d "$db" -c "select count(distinct stmt) from t_probe.results where tbl = '$r $verb $tbl'" 2>/dev/null)"
    bad="$(psql -X -q -At -d "$db" -c "select count(*) || ' of ' || (select count(*) from t_probe.results where tbl = '$r $verb $tbl') || ' state(s) are not a refusal: ' || string_agg('after statement ' || left(stmt, 44) || ' -> ' || state || ' ' || left(coalesce(msg, ''), 60), '; ' order by stmt) from (select * from t_probe.results where tbl = '$r $verb $tbl' and state <> '00000' order by stmt limit 6) x having count(*) > 0" 2>/dev/null)"
    if [ "${seen:-0}" -lt 2 ]; then
      fail "$what :: not checked, the probe saw the table in ${seen:-0} state(s)"
    elif [ -n "$bad" ]; then
      fail "$what :: $bad"
    else
      pass "$what (${seen} states)"
    fi
  done; done; done
  psql -X -q -d "$db" -c "drop schema t_probe cascade" >/dev/null 2>&1
}

# --- undecidable founding organization: decision 44 ----------------------------
#
# A FIRST application of the Drill migration on a database that already has
# two organizations: nothing tells them apart, so it raises (decisions 27, 30).
# Applied as one transaction, the failure takes back everything the migration
# had done, the flag column included. The error must therefore say how to add
# AND set the flag by hand; here that is done on the database the failed
# application left, and the migration applied again.

founding_message_says_add() {   # the same test as run.sh's
  grep -v '^CONTEXT:' "$1" | tr '\n' ' ' | grep -q 'is_founding' \
    && grep -v '^CONTEXT:' "$1" | tr '\n' ' ' | grep -q -i -E '(add[[:space:]]+column|add[[:space:]]+(the|a|this)[[:space:]]+([a-z_]+[[:space:]]+)?column|alter[[:space:]]+table[^;]*[[:space:]]add[[:space:]])'
}

phase_undecidable_founding() {
  local db="undecided" f ok=1 what
  local one="7e57da7a-0000-4000-8000-000000000011" two="7e57da7a-0000-4000-8000-000000000012"
  PHASE="hosted, undecidable founding organization"
  new_db "$db"
  load_stub "$db" hosted || { fail "[harness] the Supabase stand-in loads :: $(first_error)"; ok=0; }
  while IFS= read -r f; do
    apply "$db" "$f" || { fail "[harness] $(basename "$f") applies :: $(first_error)"; ok=0; }
  done < <(pre_tenancy_migrations)
  apply "$db" "$HERE/upgrade/seed_legacy.sql" || { fail "[harness] the legacy data loads :: $(first_error)"; ok=0; }
  [ -f "$MIG_CORE" ] && [ -f "$MIG_DRILL" ] || ok=0
  [ "$ok" -eq 1 ] && { apply "$db" "$MIG_CORE" || { fail "[harness] saas_core applies :: $(first_error)"; ok=0; }; }
  # Neither the name nor the age may decide: the one flagged below is the newer.
  [ "$ok" -eq 1 ] && psql -X -q -v ON_ERROR_STOP=1 -d "$db" >/dev/null 2>&1 <<SQL || ok=0
insert into public.organizations (id, name, created_at) values
  ('$one', 'Company one', timestamptz '2000-01-01 00:00:00+00'),
  ('$two', 'Company two', timestamptz '2020-01-01 00:00:00+00');
SQL

  if [ "$ok" -ne 1 ]; then
    for what in "[c44] a first application with two organizations and none marked raises, and says it is about the founding organization" \
                "[c44] the failed application leaves no flag column behind: this is the database the instructions must work on" \
                "[c44] the message says how to add the flag column, not only to set it" \
                "[c44] with the flag added and set by hand on that database, the migration applies" \
                "[c44] ... the organization flagged by hand is the founding one, and the only one" \
                "[c44] ... every legacy account is enrolled there, and nobody in the other organization" \
                "[c44] ... every legacy row is assigned there, and none to the other organization" \
                "[c44] ... and a legacy driller's borehole sent without org_id is accepted, into that organization"; do
      fail "$what :: not checked, the database could not be prepared"
    done
    return
  fi

  what="[c44] a first application with two organizations and none marked raises, and says it is about the founding organization"
  if apply "$db" "$MIG_DRILL"; then
    fail "$what :: the migration ran to its end"
  elif ! grep -q -i 'founding' "$WORK/apply.err"; then
    fail "$what :: it stopped, but on something else: $(first_error | cut -c 1-200)"
  else
    pass "$what"
  fi
  cp "$WORK/apply.err" "$WORK/founding.err"

  what="[c44] the failed application leaves no flag column behind: this is the database the instructions must work on"
  if [ "$(psql -X -q -At -d "$db" -c "select (not exists (select 1 from pg_attribute where attrelid = 'public.organizations'::regclass and attname = 'is_founding' and not attisdropped) and not exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped))::int" 2>/dev/null)" = "1" ]; then
    pass "$what"
  else
    fail "$what :: organizations.is_founding or boreholes.org_id exists after the failed application"
  fi

  what="[c44] the message says how to add the flag column, not only to set it"
  if ! grep -q -i 'founding' "$WORK/founding.err"; then
    fail "$what :: not checked, the migration did not stop on the founding organization"
  elif founding_message_says_add "$WORK/founding.err"; then
    pass "$what"
  else
    fail "$what :: the message is: $(grep -m 1 ERROR "$WORK/founding.err" | sed 's/^psql:[^ ]* //' | cut -c 1-260)"
  fi

  # By hand: add the flag, set it on the organization that is the founding one.
  psql -X -q -v ON_ERROR_STOP=1 -d "$db" >/dev/null 2>"$WORK/byhand.err" <<SQL
alter table public.organizations add column is_founding boolean not null default false;
update public.organizations set is_founding = true where id = '$two';
SQL
  what="[c44] with the flag added and set by hand on that database, the migration applies"
  if [ -s "$WORK/byhand.err" ]; then
    fail "$what :: the flag could not be added by hand: $(head -n 1 "$WORK/byhand.err")"
  elif apply "$db" "$MIG_DRILL"; then
    pass "$what"
  else
    fail "$what :: $(first_error)"
  fi

  what="[c44] ... the organization flagged by hand is the founding one, and the only one"
  if [ "$(psql -X -q -At -d "$db" -c "select string_agg(id::text, ',' order by id) from public.organizations where is_founding" 2>/dev/null)" = "$two" ]; then
    pass "$what"
  else
    fail "$what :: flagged: $(psql -X -q -At -d "$db" -c "select coalesce(string_agg(name, ', ' order by name), 'none') from public.organizations where is_founding" 2>&1 | head -n 1)"
  fi

  what="[c44] ... every legacy account is enrolled there, and nobody in the other organization"
  if [ "$(psql -X -q -At -d "$db" -c "select ((select count(*) from public.memberships where org_id = '$two') = 6 and (select count(*) from public.memberships where org_id <> '$two') = 0 and (select count(*) from public.organizations) = 2)::int" 2>/dev/null)" = "1" ]; then
    pass "$what"
  else
    fail "$what :: memberships per organization: $(psql -X -q -At -d "$db" -c "select coalesce(string_agg(name || ' ' || (select count(*) from public.memberships m where m.org_id = o.id), ', ' order by name), 'none') from public.organizations o" 2>&1 | head -n 1)"
  fi

  what="[c44] ... every legacy row is assigned there, and none to the other organization"
  if [ "$(psql -X -q -At -d "$db" -c "select ((select count(*) from public.boreholes where org_id = '$two') = 3 and (select count(*) from public.pipe_records where org_id = '$two') = 3 and (select count(*) from public.drilling_events where org_id = '$two') = 1 and (select count(*) from public.shift_logs where org_id = '$two') = 2 and (select count(*) from public.boreholes where org_id <> '$two') = 0)::int" 2>/dev/null)" = "1" ]; then
    pass "$what"
  else
    fail "$what :: boreholes per organization: $(psql -X -q -At -d "$db" -c "select coalesce(string_agg(name || ' ' || (select count(*) from public.boreholes b where b.org_id = o.id), ', ' order by name), 'none') from public.organizations o" 2>&1 | head -n 1)"
  fi

  # What the instructions are for: the crew works again.
  what="[c44] ... and a legacy driller's borehole sent without org_id is accepted, into that organization"
  if [ "$(psql -X -q -At -d "$db" 2>"$WORK/byhand.err" <<SQL | tail -n 1
begin;
select set_config('request.jwt.claims', json_build_object('sub', md5('drill-db-test:l_driller')::uuid, 'role', 'authenticated')::text, true) \\gset ignore_
set local role authenticated;
with i as (insert into public.boreholes (id, name, created_by, recorded_at)
           values (gen_random_uuid(), 'by hand', md5('drill-db-test:l_driller')::uuid, now()) returning org_id)
select (org_id = '$two')::int from i;
rollback;
SQL
)" = "1" ]; then
    pass "$what"
  else
    fail "$what :: $(grep -m 1 ERROR "$WORK/byhand.err" | cut -c 1-200)"
  fi
}

# --- in flight: decision 39 -----------------------------------------------------
#
# The window probe above acts BETWEEN statements: each of its writes is
# committed before the next statement starts. A dashboard request that is
# under way while a statement runs is a transaction the statement cannot see
# yet. lib/in_flight.py holds such transactions open across every statement
# and commits them only when the migration waits for them, or after it.

phase_in_flight() {
  local mode="$1" db="inflight_$1" f ok=1 line n=0
  PHASE="hosted, in flight ($mode)"
  new_db "$db"
  load_stub "$db" hosted || { fail "[harness] the Supabase stand-in loads :: $(first_error)"; ok=0; }
  while IFS= read -r f; do
    apply "$db" "$f" || { fail "[harness] $(basename "$f") applies :: $(first_error)"; ok=0; }
  done < <(pre_tenancy_migrations)
  apply "$db" "$HERE/upgrade/seed_legacy.sql" || { fail "[harness] the legacy data loads :: $(first_error)"; ok=0; }
  [ -f "$MIG_CORE" ] && [ -f "$MIG_DRILL" ] || ok=0
  [ "$ok" -eq 1 ] && { apply "$db" "$MIG_CORE" || { fail "[harness] saas_core applies :: $(first_error)"; ok=0; }; }

  if [ "$ok" -ne 1 ]; then
    fail "[c39] in flight ($mode): accounts being created, re-roled, banned and unbanned while the migration runs :: not checked, the database could not be prepared or a migration is missing"
    return
  fi

  python3 "$HERE/lib/in_flight.py" "$db" "$MIG_DRILL" "$mode" >"$WORK/inflight.out" 2>"$WORK/inflight.err"
  while IFS= read -r line; do
    case "$line" in
      "ok	"*)   n=$((n + 1)); pass "${line#ok	}" ;;
      "FAIL	"*) n=$((n + 1)); fail "${line#FAIL	}" ;;
      "")       ;;
      *)        echo "$line" ;;
    esac
  done <"$WORK/inflight.out"
  # Five outcomes and the harness's own check, or the tool did not run to its end.
  if [ "$n" -ne 6 ] || [ -s "$WORK/inflight.err" ]; then
    fail "[harness] in flight ($mode): lib/in_flight.py ran to its end :: $n of 6 lines; $(head -n 1 "$WORK/inflight.err" | cut -c 1-200)"
  fi

  # Whatever was in flight, the result is the same working database.
  psql -X -q -d "$db" -c "delete from auth.users where email ~ '^fly-(new|role|ban|unban)-[0-9]+@db-test[.]invalid\$'" >/dev/null 2>&1
  suite "$db" "$HERE/upgrade/after_migration.sql"
}

# --- in flight, on the other two kinds of first application ---------------------
#
# Added in the validation of b548412 (criteria 39 and 51). phase_in_flight
# starts from legacy data with no organization and no membership. The Drill
# migration also does its enrolment in two other states, and in each of them
# a part of it mattered that the run above cannot see:
#
#   reapply  the Drill rollback alone was applied and the migration is
#            applied again: every account still HAS its founding membership,
#            the mark is gone. The memberships are brought into line with the
#            legacy tables by an UPDATE; with the lock taken only after that
#            UPDATE, a ban or a re-role in flight was read too early and
#            missed, and nothing failed.
#   byhand   the founding organization was marked by hand before the first
#            application (the procedure of decision 44). The mirrors then
#            find a founding organization but no membership; with the lock
#            taken only when no organization is marked, a ban or a re-role in
#            flight was missed, and nothing failed.
#
# The same tool, the same six lines, the same expectations.

phase_in_flight_other() {
  local kind="$1" mode="$2" db="inflight_$1_$2" f ok=1 line n=0 got
  PHASE="hosted, in flight, $kind ($mode)"
  new_db "$db"
  load_stub "$db" hosted || { fail "[harness] the Supabase stand-in loads :: $(first_error)"; ok=0; }
  while IFS= read -r f; do
    apply "$db" "$f" || { fail "[harness] $(basename "$f") applies :: $(first_error)"; ok=0; }
  done < <(pre_tenancy_migrations)
  apply "$db" "$HERE/upgrade/seed_legacy.sql" || { fail "[harness] the legacy data loads :: $(first_error)"; ok=0; }
  [ -f "$MIG_CORE" ] && [ -f "$MIG_DRILL" ] && [ -f "$RB_DRILL" ] || ok=0
  [ "$ok" -eq 1 ] && { apply "$db" "$MIG_CORE" || { fail "[harness] saas_core applies :: $(first_error)"; ok=0; }; }

  if [ "$ok" -eq 1 ] && [ "$kind" = "reapply" ]; then
    apply "$db" "$MIG_DRILL" || { fail "[harness] drill_tenancy applies :: $(first_error)"; ok=0; }
    python3 "$HERE/lib/in_flight.py" "$db" "$MIG_DRILL" "$mode" prepare >/dev/null 2>"$WORK/inflight.err" \
      || { fail "[harness] the accounts to act on are created while the migration is in force :: $(head -n 1 "$WORK/inflight.err" | cut -c 1-200)"; ok=0; }
    [ "$ok" -eq 1 ] && { apply "$db" "$RB_DRILL" || { fail "[harness] the Drill rollback alone applies :: $(first_error)"; ok=0; }; }
    # What the run is about: the accounts are members already, and no organization is marked.
    got="$(psql -X -q -At -d "$db" -c "select (count(*) >= 3 and count(*) = count(m.user_id) and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'organizations' and column_name = 'is_founding'))::int from auth.users u left join public.memberships m on m.user_id = u.id where u.email ~ '^fly-(role|ban|unban)-[0-9]+@db-test[.]invalid\$'" 2>/dev/null)"
    if [ "$ok" -eq 1 ] && [ "$got" = "1" ]; then
      pass "[harness] in flight, re-application ($mode): every account to re-role, ban or unban has its membership from before the rollback, and no organization is marked"
    else
      fail "[harness] in flight, re-application ($mode): every account to re-role, ban or unban has its membership from before the rollback, and no organization is marked"
      ok=0
    fi
  elif [ "$ok" -eq 1 ]; then
    psql -X -q -v ON_ERROR_STOP=1 -d "$db" >/dev/null 2>"$WORK/apply.err" <<'SQL' || { fail "[harness] one organization, marked founding by hand :: $(first_error)"; ok=0; }
insert into public.organizations (id, name) values ('7e57da7a-0000-4000-8000-000000000511', 'Marked by hand');
alter table public.organizations add column is_founding boolean not null default false;
update public.organizations set is_founding = true;
SQL
    got="$(psql -X -q -At -d "$db" -c "select ((select count(*) from public.organizations where is_founding) = 1 and not exists (select 1 from public.memberships))::int" 2>/dev/null)"
    if [ "$ok" -eq 1 ] && [ "$got" = "1" ]; then
      pass "[harness] in flight, marked by hand ($mode): one organization is marked founding and nobody is a member of anything"
    else
      fail "[harness] in flight, marked by hand ($mode): one organization is marked founding and nobody is a member of anything"
      ok=0
    fi
  fi

  if [ "$ok" -ne 1 ]; then
    fail "[c39][c51] in flight, $kind ($mode): accounts being created, re-roled, banned and unbanned while the migration runs :: not checked, the database could not be prepared or a file is missing"
    return
  fi

  python3 "$HERE/lib/in_flight.py" "$db" "$MIG_DRILL" "$mode" >"$WORK/inflight.out" 2>"$WORK/inflight.err"
  while IFS= read -r line; do
    case "$line" in
      "ok	"*)   n=$((n + 1)); pass "${line#ok	}" ;;
      "FAIL	"*) n=$((n + 1)); fail "${line#FAIL	}" ;;
      "")       ;;
      *)        echo "$line" ;;
    esac
  done <"$WORK/inflight.out"
  if [ "$n" -ne 6 ] || [ -s "$WORK/inflight.err" ]; then
    fail "[harness] in flight, $kind ($mode): lib/in_flight.py ran to its end :: $n of 6 lines; $(head -n 1 "$WORK/inflight.err" | cut -c 1-200)"
  fi
}

# --- rollback, statement by statement: criterion 47 -----------------------------
#
# RF-088: the Drill rollback, run without one wrapping transaction, passed
# through states in which a signed-in user could set their own profiles.role
# and an installed build's upsert or upload was refused with an error the app
# drops for good. The same look the forward migration gets, for the rollback:
# upgrade/rollback_window_probe.sql before the first statement (label 000)
# and after every statement.

RB_OPS_ROLE="own role: driller, update|own role: driller, update with name|own role: driller, upsert|own role: supervisor, update"
RB_OPS_BUILD="insert boreholes|insert pipe_records|insert drilling_events|insert shift_logs|upsert boreholes|upsert pipe_records|upsert drilling_events|upsert shift_logs|photo upload|read own boreholes|read own pipe_records|read own drilling_events|read own shift_logs|read own profile|read own photo|new account: insert boreholes|unbanned account: insert boreholes"

rb_role_name()  { echo "[c47] $1: after every statement of the Drill rollback a signed-in user still cannot make themselves Administrator"; }
rb_build_name() { echo "[c47] $1: after every statement of the Drill rollback an installed build gets nothing worse than before the rollback or after it"; }

phase_rollback_statement_by_statement() {
  local db="rbstep" f s d rc op what n stmts first last bad seen ok=1 ran=0
  PHASE="hosted, rollback statement by statement"
  new_db "$db"
  load_stub "$db" hosted || { fail "[harness] the Supabase stand-in loads :: $(first_error)"; ok=0; }
  while IFS= read -r f; do
    apply "$db" "$f" || { fail "[harness] $(basename "$f") applies :: $(first_error)"; ok=0; }
  done < <(pre_tenancy_migrations)
  apply "$db" "$HERE/upgrade/seed_legacy.sql" || { fail "[harness] the legacy data loads :: $(first_error)"; ok=0; }
  rm -f "$WORK"/rb.snap.before "$WORK"/rb.snap.after "$WORK"/rb.digest.before "$WORK"/rb.digest.after
  snapshot "$db" "$WORK/rb.snap.before" || ok=0
  digest "$db" "$WORK/rb.digest.before" || ok=0
  [ -f "$MIG_CORE" ] && [ -f "$MIG_DRILL" ] && [ -f "$RB_DRILL" ] && [ -f "$RB_CORE" ] || ok=0
  if [ "$ok" -eq 1 ]; then
    apply "$db" "$MIG_CORE"  || { fail "[harness] saas_core applies :: $(first_error)"; ok=0; }
    apply "$db" "$MIG_DRILL" || { fail "[harness] drill_tenancy applies :: $(first_error)"; ok=0; }
  fi

  if [ "$ok" -eq 1 ]; then
    psql -X -q -v ON_ERROR_STOP=1 -d "$db" >/dev/null 2>&1 <<'SQL'
create schema t_probe;
create table t_probe.results (stmt text, tbl text, state text, msg text);
SQL
    {
      echo "select set_config('drill.stmt', '000 before the rollback', false) \\gset drill_ignore_"
      echo "\\i '$HERE/upgrade/rollback_window_probe.sql'"
      python3 "$HERE/lib/sql_statements.py" probe-script "$RB_DRILL" "$HERE/upgrade/rollback_window_probe.sql"
    } >"$WORK/rbstep.sql"
    stmts="$(grep -c "^select set_config('drill.stmt'" "$WORK/rbstep.sql")"
    stmts=$((stmts - 1))
    psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$WORK/rbstep.sql" >/dev/null 2>"$WORK/apply.err"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      pass "[c47] the Drill rollback applies one statement at a time ($stmts statements)"
      ran=1
    else
      fail "[c47] the Drill rollback applies one statement at a time :: $(first_error)"
    fi
  else
    fail "[c47] the Drill rollback applies one statement at a time :: not checked, the migrated database could not be prepared or a file is missing"
  fi

  n="$(psql -X -q -At -d "$db" -c "select count(distinct stmt) from t_probe.results" 2>/dev/null)"
  first="$(psql -X -q -At -d "$db" -c "select min(stmt) from t_probe.results" 2>/dev/null)"
  last="$(psql -X -q -At -d "$db" -c "select max(stmt) from t_probe.results" 2>/dev/null)"
  what="[c47] the states in between were looked at: before the first statement and after every one"
  if [ "$ran" -eq 1 ] && [ "${stmts:-0}" -ge 3 ] && [ "${n:-0}" -eq $((stmts + 1)) ] && [ "${first%% *}" = "000" ]; then
    pass "$what (${n} states)"
  else
    fail "$what :: ${n:-0} state(s) seen for ${stmts:-0} statement(s)"
    ran=0
  fi

  # The probe has something to say: before the rollback and after it, every
  # operation of an installed build works, a user cannot change their own
  # role, and each attempt at the role is a statement that DOES change it
  # when the role applying the rollback runs it.
  for s in "before the first statement|$first" "after the last statement|$last"; do
    what="[harness] ${s%%|*} of the Drill rollback: every operation of the probe works, nobody can change their own role, and the attempts are valid statements"
    if [ "$ran" -ne 1 ]; then
      fail "$what :: not checked, the rollback did not run to its end"
      continue
    fi
    bad="$(psql -X -q -At -v at="${s##*|}" -d "$db" 2>/dev/null <<'SQL'
select count(*) || ' of ' || (select count(*) from t_probe.results where stmt = :'at') || ' are not as expected: '
       || string_agg(tbl || ' -> ' || state || ' ' || left(coalesce(msg, ''), 60), '; ' order by tbl)
from t_probe.results where stmt = :'at' and state <> '00000' having count(*) > 0;
SQL
)"
    seen="$(psql -X -q -At -d "$db" -c "select count(*) from t_probe.results where stmt = \$\$${s##*|}\$\$" 2>/dev/null)"
    if [ "${seen:-0}" -ne 25 ]; then
      fail "$what :: the probe recorded ${seen:-0} of 25 results there"
    elif [ -n "$bad" ]; then
      fail "$what :: $bad"
    else
      pass "$what"
    fi
  done

  # (a) nobody can change their own role, in any state.
  while IFS= read -r op; do
    what="$(rb_role_name "$op")"
    if [ "$ran" -ne 1 ]; then
      fail "$what :: not checked, the rollback did not run to its end"
      continue
    fi
    seen="$(psql -X -q -At -v op="$op" -d "$db" 2>/dev/null <<'SQL'
select count(distinct stmt) from t_probe.results where tbl = :'op';
SQL
)"
    bad="$(psql -X -q -At -v op="$op" -d "$db" 2>/dev/null <<'SQL'
select count(*) || ' state(s) let it through: ' || string_agg('after statement ' || left(stmt, 64) || ' -> ' || state || ' ' || left(coalesce(msg, ''), 50), '; ' order by stmt)
from (select * from t_probe.results where tbl = :'op' and state <> '00000' order by stmt limit 40) x having count(*) > 0;
SQL
)"
    if [ "${seen:-0}" -ne "${n:-0}" ]; then
      fail "$what :: not checked, tried in ${seen:-0} of ${n:-0} states"
    elif [ -n "$bad" ]; then
      fail "$what :: $bad"
    else
      pass "$what (${seen} states)"
    fi
  done < <(printf '%s\n' "$RB_OPS_ROLE" | tr '|' '\n')

  # (b) the installed build: never worse than before or after.
  while IFS= read -r op; do
    what="$(rb_build_name "$op")"
    if [ "$ran" -ne 1 ]; then
      fail "$what :: not checked, the rollback did not run to its end"
      continue
    fi
    seen="$(psql -X -q -At -v op="$op" -d "$db" 2>/dev/null <<'SQL'
select count(distinct stmt) from t_probe.results where tbl = :'op';
SQL
)"
    bad="$(psql -X -q -At -v op="$op" -v first="$first" -v last="$last" -d "$db" 2>/dev/null <<'SQL'
select count(*) || ' state(s) are worse (before the rollback: ' || (select state from t_probe.results where tbl = :'op' and stmt = :'first')
       || ', after it: ' || (select state from t_probe.results where tbl = :'op' and stmt = :'last') || '): '
       || string_agg('after statement ' || left(stmt, 64) || ' -> ' || state || ' ' || left(coalesce(msg, ''), 60), '; ' order by stmt)
from (select * from t_probe.results r
      where tbl = :'op' and state <> '00000'
        and state is distinct from (select state from t_probe.results where tbl = :'op' and stmt = :'first')
        and state is distinct from (select state from t_probe.results where tbl = :'op' and stmt = :'last')
      order by stmt limit 40) x having count(*) > 0;
SQL
)"
    if [ "${seen:-0}" -ne "${n:-0}" ]; then
      fail "$what :: not checked, tried in ${seen:-0} of ${n:-0} states"
    elif [ -n "$bad" ]; then
      fail "$what :: $bad"
    else
      pass "$what (${seen} states)"
    fi
  done < <(printf '%s\n' "$RB_OPS_BUILD" | tr '|' '\n')

  # Applied this way the result must be what a rollback in one piece gives:
  # with the saas_core rollback after it, the database from before the
  # migrations, and the installed build's behaviour with it.
  psql -X -q -d "$db" -c "drop schema if exists t_probe cascade" >/dev/null 2>&1
  if [ "$ran" -eq 1 ] && apply "$db" "$RB_CORE"; then
    pass "[c47][c14] the saas_core rollback runs after the Drill rollback applied one statement at a time"
    what="[c47][c14] ... and every row, account and photo is as before the migrations"
    if digest "$db" "$WORK/rb.digest.after"; then
      d="$(diff "$WORK/rb.digest.before" "$WORK/rb.digest.after")"
      if [ -z "$d" ]; then pass "$what"; else fail "$what :: $(printf '%s' "$d" | grep '^[<>]' | tr '\n' ';')"; fi
    else
      fail "$what :: the digest could not be taken: $(head -n 1 "$WORK/digest.err")"
    fi
    snapshot "$db" "$WORK/rb.snap.after"
    for s in $SECTIONS; do
      same_section "$s" "$WORK/rb.snap.before" "$WORK/rb.snap.after" "[c47][c14] ... and the $s are exactly what they were before the migrations"
    done
    suite "$db" "$HERE/sql/05_legacy_client.sql"
  else
    fail "[c47][c14] the saas_core rollback runs after the Drill rollback applied one statement at a time :: $([ "$ran" -eq 1 ] && first_error || echo 'not checked, the Drill rollback did not run to its end')"
    fail "[c47][c14] ... and every row, account and photo is as before the migrations :: not checked"
    for s in $SECTIONS; do
      fail "[c47][c14] ... and the $s are exactly what they were before the migrations :: not checked"
    done
    fail "[c47][c14] ... and the installed build's behaviour is back :: not checked"
  fi
}

# --- rollback guard, no members: criterion 48 ------------------------------------
#
# RF-091: the guard counted organizations holding records and looked at
# memberships, so a company whose members had been removed was merged into
# the legacy pool with whatever it still held. Each case gets its own copy of
# one prepared database (guards/c48_fixture.sql, committed), and the rollback
# is applied one statement per transaction, so "changes nothing" does not
# lean on a surrounding transaction.

C48_ROWS="select coalesce(md5(string_agg(x, '|' order by x)), 'none') from (select 'o:' || to_jsonb(o)::text as x from public.organizations o union all select 'm:' || to_jsonb(m)::text from public.memberships m union all select 'b:' || to_jsonb(b)::text from public.boreholes b union all select 'p:' || to_jsonb(p)::text from public.pipe_records p union all select 'e:' || to_jsonb(e)::text from public.drilling_events e union all select 's:' || to_jsonb(l)::text from public.shift_logs l union all select 'f:' || bucket_id || ':' || name from storage.objects union all select 'u:' || id::text from auth.users) r"

c48_label() {   # c48_label <what> <founding_empty>
  local label
  case "$1" in
    photo) label="a photo is stored under the folder of a non-founding organization that has no members and no records" ;;
    boreholes) label="a non-founding organization that has no members holds a borehole" ;;
    *) case "$2" in
         1) label="a non-founding organization that has no members holds a borehole and a row of $1" ;;
         *) label="a non-founding organization that has no members holds a row of $1, under a borehole of the founding organization" ;;
       esac ;;
  esac
  case "$2" in
    1) echo "$label, and the founding organization holds no record at all" ;;
    *) echo "$label (the founding organization holds records too)" ;;
  esac
}

phase_rollback_guard_no_members() {
  local tpl="g48_tpl" db f what empty label rc before after d what_check i=0 ok=1
  PHASE="hosted, rollback guard (no members)"
  new_db "$tpl"
  load_stub "$tpl" hosted || { fail "[harness] the Supabase stand-in loads :: $(first_error)"; ok=0; }
  while IFS= read -r f; do
    apply "$tpl" "$f" || { fail "[harness] $(basename "$f") applies :: $(first_error)"; ok=0; }
  done < <(all_migrations)
  [ -f "$MIG_DRILL" ] && [ -f "$RB_DRILL" ] && [ -f "$RB_CORE" ] || ok=0

  for what in boreholes pipe_records drilling_events shift_logs photo; do
    for empty in 0 1; do
      i=$((i + 1))
      db="g48_$i"
      label="$(c48_label "$what" "$empty")"
      if [ "$ok" -ne 1 ]; then
        fail "[c48] the Drill rollback raises, by refusing, when $label :: not checked, the database could not be prepared"
        fail "[c48] ... and changed nothing in the catalog, though applied one statement at a time ($what, founding empty: $empty) :: not checked"
        fail "[c48] ... and every organization, membership, record, photo and account is as it was ($what, founding empty: $empty) :: not checked"
        continue
      fi
      psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "create database \"$db\" template \"$tpl\"" >/dev/null 2>"$WORK/apply.err"
      psql -X -q -At -v ON_ERROR_STOP=1 -v what="$what" -v founding_empty="$empty" -d "$db" \
        -f "$HERE/guards/c48_fixture.sql" >"$WORK/c48.out" 2>"$WORK/apply.err"
      if ! grep -q '^FIXTURE-READY$' "$WORK/c48.out"; then
        fail "[c48] the Drill rollback raises, by refusing, when $label :: not checked, the fixture did not load: $(first_error)"
        fail "[c48] ... and changed nothing in the catalog, though applied one statement at a time ($what, founding empty: $empty) :: not checked"
        fail "[c48] ... and every organization, membership, record, photo and account is as it was ($what, founding empty: $empty) :: not checked"
        continue
      fi
      rm -f "$WORK"/c48.snap.before "$WORK"/c48.snap.after
      snapshot "$db" "$WORK/c48.snap.before"
      before="$(psql -X -q -At -d "$db" -c "$C48_ROWS" 2>/dev/null)"

      psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$RB_DRILL" >/dev/null 2>"$WORK/apply.err"
      rc=$?
      what_check="[c48] the Drill rollback raises, by refusing, when $label"
      if [ "$rc" -eq 0 ]; then
        fail "$what_check :: it ran to its end"
      elif ! grep -q -i 'refus' "$WORK/apply.err"; then
        fail "$what_check :: it stopped, but not by refusing: $(first_error | cut -c 1-200)"
      else
        pass "$what_check"
      fi

      what_check="[c48] ... and changed nothing in the catalog, though applied one statement at a time ($what, founding empty: $empty)"
      snapshot "$db" "$WORK/c48.snap.after"
      if [ ! -s "$WORK/c48.snap.before" ] || [ ! -s "$WORK/c48.snap.after" ]; then
        fail "$what_check :: not checked, a snapshot is missing or empty"
      else
        d="$(diff "$WORK/c48.snap.before" "$WORK/c48.snap.after")"
        if [ -z "$d" ]; then
          pass "$what_check"
        else
          fail "$what_check :: $(printf '%s' "$d" | grep -c '^[<>]') line(s) differ, for instance: $(printf '%s' "$d" | grep '^[<>]' | head -n 3 | cut -c 1-160 | tr '\n' ';')"
        fi
      fi

      what_check="[c48] ... and every organization, membership, record, photo and account is as it was ($what, founding empty: $empty)"
      after="$(psql -X -q -At -d "$db" -c "$C48_ROWS" 2>/dev/null)"
      if [ -n "$before" ] && [ "$before" != "none" ] && [ "$before" = "$after" ]; then
        pass "$what_check"
      else
        fail "$what_check :: the rows changed, or a column of theirs is gone"
      fi
      psql -X -q -d postgres -c "drop database if exists \"$db\"" >/dev/null 2>&1
    done
  done

  # Nothing of another organization's is stored: the rollback runs, although a
  # second organization exists and the founding one has a photo under its own
  # folder.
  db="g48_runs"
  if [ "$ok" -eq 1 ]; then
    psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "create database \"$db\" template \"$tpl\"" >/dev/null 2>"$WORK/apply.err"
    psql -X -q -At -v ON_ERROR_STOP=1 -v what="nothing" -v founding_empty="0" -d "$db" \
      -f "$HERE/guards/c48_fixture.sql" >"$WORK/c48.out" 2>"$WORK/apply.err"
    if grep -q '^FIXTURE-READY$' "$WORK/c48.out"; then
      apply_checked "$db" "$RB_DRILL" "[c48] with a second, empty organization and everything stored in the founding one (records in all four tables, a photo under its folder, a legacy photo), the Drill rollback runs"
      apply_checked "$db" "$RB_CORE"  "[c48] ... and the saas_core rollback after it"
    else
      fail "[c48] with a second, empty organization and everything stored in the founding one (records in all four tables, a photo under its folder, a legacy photo), the Drill rollback runs :: not checked, the fixture did not load: $(first_error)"
      fail "[c48] ... and the saas_core rollback after it :: not checked"
    fi
  else
    fail "[c48] with a second, empty organization and everything stored in the founding one (records in all four tables, a photo under its folder, a legacy photo), the Drill rollback runs :: not checked, the database could not be prepared"
    fail "[c48] ... and the saas_core rollback after it :: not checked"
  fi
}

# --- first application, second organization: criterion 49 -----------------------
#
# RF-093: a first application enrolled EVERY profile in the founding
# organization, also the accounts that belong to another company only. Here
# the foundation is in place, two organizations exist, and two legacy
# accounts (one of them banned) already belong to the first of them and to
# nothing else. The second is marked founding by hand, as the migration's
# own error says to (decision 44), and the Drill migration is applied for
# the first time.

phase_first_application_second_org() {
  local db="first49" f ok=1 what got
  local other="7e57da7a-0000-4000-8000-000000000491" founding="7e57da7a-0000-4000-8000-000000000492"
  local m="select coalesce(string_agg(format('%s/%s/%s', role, status, coalesce(badge_number, '-')), ' + ' order by org_id), 'no membership') from public.memberships"
  PHASE="hosted, first application with a second organization"
  new_db "$db"
  load_stub "$db" hosted || { fail "[harness] the Supabase stand-in loads :: $(first_error)"; ok=0; }
  while IFS= read -r f; do
    apply "$db" "$f" || { fail "[harness] $(basename "$f") applies :: $(first_error)"; ok=0; }
  done < <(pre_tenancy_migrations)
  apply "$db" "$HERE/upgrade/seed_legacy.sql" || { fail "[harness] the legacy data loads :: $(first_error)"; ok=0; }
  [ -f "$MIG_CORE" ] && [ -f "$MIG_DRILL" ] || ok=0
  [ "$ok" -eq 1 ] && { apply "$db" "$MIG_CORE" || { fail "[harness] saas_core applies :: $(first_error)"; ok=0; }; }
  if [ "$ok" -eq 1 ]; then
    psql -X -q -v ON_ERROR_STOP=1 -d "$db" >/dev/null 2>"$WORK/apply.err" <<SQL || { fail "[harness] two organizations, two accounts in the other one, the flag set by hand :: $(first_error)"; ok=0; }
insert into public.organizations (id, name, created_at) values
  ('$other',    'Other company',    timestamptz '2000-01-01 00:00:00+00'),
  ('$founding', 'Founding company', timestamptz '2020-01-01 00:00:00+00');
insert into public.memberships (org_id, user_id, role, status, badge_number) values
  ('$other', md5('drill-db-test:l_logger')::uuid, 'Supervisor', 'active', 'O-1'),
  ('$other', md5('drill-db-test:l_banned')::uuid, 'Driller',    'active', null);
alter table public.organizations add column is_founding boolean not null default false;
update public.organizations set is_founding = true where id = '$founding';
SQL
  fi

  if [ "$ok" -ne 1 ]; then
    for what in "[c49] a first application applies when two accounts already belong to another organization only" \
                "[c49] ... the account that belongs to the other organization only gets no founding membership" \
                "[c49] ... nor does the banned account that belongs to the other organization only" \
                "[c49] ... their memberships in the other organization are exactly as they were: role, status and badge" \
                "[c49] ... the four accounts with no membership anywhere are enrolled in the founding organization with their profile's role and badge" \
                "[c49] ... and nobody else is a member of anything: four memberships in the founding organization, two in the other"; do
      fail "$what :: not checked, the database could not be prepared"
    done
    return
  fi

  if ! apply_checked "$db" "$MIG_DRILL" "[c49] a first application applies when two accounts already belong to another organization only"; then
    for what in "[c49] ... the account that belongs to the other organization only gets no founding membership" \
                "[c49] ... nor does the banned account that belongs to the other organization only" \
                "[c49] ... their memberships in the other organization are exactly as they were: role, status and badge" \
                "[c49] ... the four accounts with no membership anywhere are enrolled in the founding organization with their profile's role and badge" \
                "[c49] ... and nobody else is a member of anything: four memberships in the founding organization, two in the other"; do
      fail "$what :: not checked, the migration did not apply"
    done
    return
  fi

  what="[c49] ... the account that belongs to the other organization only gets no founding membership"
  got="$(psql -X -q -At -d "$db" -c "$m where user_id = md5('drill-db-test:l_logger')::uuid and org_id = '$founding'" 2>&1 | head -n 1)"
  if [ "$got" = "no membership" ]; then pass "$what"; else fail "$what :: found there: $got"; fi

  what="[c49] ... nor does the banned account that belongs to the other organization only"
  got="$(psql -X -q -At -d "$db" -c "$m where user_id = md5('drill-db-test:l_banned')::uuid and org_id = '$founding'" 2>&1 | head -n 1)"
  if [ "$got" = "no membership" ]; then pass "$what"; else fail "$what :: found there: $got"; fi

  what="[c49] ... their memberships in the other organization are exactly as they were: role, status and badge"
  got="$(psql -X -q -At -d "$db" -c "select ($m where user_id = md5('drill-db-test:l_logger')::uuid and org_id = '$other') || ' and ' || ($m where user_id = md5('drill-db-test:l_banned')::uuid and org_id = '$other')" 2>&1 | head -n 1)"
  if [ "$got" = "Supervisor/active/O-1 and Driller/active/-" ]; then pass "$what"; else fail "$what :: found: $got"; fi

  what="[c49] ... the four accounts with no membership anywhere are enrolled in the founding organization with their profile's role and badge"
  got="$(psql -X -q -At -d "$db" -c "select string_agg(a || ' ' || ($m where user_id = md5('drill-db-test:' || a)::uuid and org_id = '$founding'), ', ' order by a) from unnest(array['l_driller', 'l_super', 'l_admin', 'l_expired']) a" 2>&1 | head -n 1)"
  if [ "$got" = "l_admin Administrator/active/-, l_driller Driller/active/D-1, l_expired Supervisor/active/-, l_super Supervisor/active/S-1" ]; then pass "$what"; else fail "$what :: found: $got"; fi

  what="[c49] ... and nobody else is a member of anything: four memberships in the founding organization, two in the other"
  got="$(psql -X -q -At -d "$db" -c "select (select count(*) from public.memberships where org_id = '$founding') || ' and ' || (select count(*) from public.memberships where org_id = '$other') || ' of ' || (select count(*) from public.memberships)" 2>&1 | head -n 1)"
  if [ "$got" = "4 and 2 of 6" ]; then pass "$what"; else fail "$what :: found: $got"; fi
}

phase_statement_by_statement
phase_rollback_statement_by_statement
phase_rollback_guard
phase_rollback_guard_members
phase_rollback_guard_no_members
phase_first_application_second_org
phase_core_statement_by_statement
phase_undecidable_founding
phase_in_flight stepwise
phase_in_flight single
phase_in_flight_other reapply stepwise
phase_in_flight_other reapply single
phase_in_flight_other byhand stepwise
phase_in_flight_other byhand single

# --- core: the foundation alone, twice ----------------------------------------

PHASE="core"
new_db core
load_stub core bare || fail "[harness] the Supabase stand-in loads :: $(first_error)"
if apply_checked core "$MIG_CORE" "[A] saas_core applies to a database with nothing of Drill's in it"; then
  snapshot core "$WORK/core.1" || fail "[harness] catalog snapshot of the foundation :: $(head -n 1 "$WORK/snap.err")"
  psql -X -q -v ON_ERROR_STOP=1 -d core >/dev/null 2>&1 <<'SQL'
insert into public.organizations (id, name) values ('00000000-0000-0000-0000-0000000000aa', 'Kept');
SQL
  if apply_checked core "$MIG_CORE" "[c4] saas_core applies a second time without error"; then
    snapshot core "$WORK/core.2" || fail "[harness] catalog snapshot after the second application :: $(head -n 1 "$WORK/snap.err")"
    for s in $SECTIONS; do
      same_section "$s" "$WORK/core.1" "$WORK/core.2" "[c4] a second application leaves the $s unchanged"
    done
    kept="$(psql -X -q -At -d core -c "select count(*) from public.organizations where name = 'Kept'" 2>/dev/null)"
    [ "$kept" = "1" ] && pass "[c4] a second application keeps existing rows" \
                      || fail "[c4] a second application keeps existing rows :: the organization row is gone"
  else
    for s in $SECTIONS; do
      fail "[c4] a second application leaves the $s unchanged :: not checked"
    done
    fail "[c4] a second application keeps existing rows :: not checked"
  fi
  psql -X -q -d core -c "delete from public.organizations where name = 'Kept'" >/dev/null 2>&1
else
  fail "[c4] saas_core applies a second time without error :: not checked"
  for s in $SECTIONS; do
    fail "[c4] a second application leaves the $s unchanged :: not checked"
  done
  fail "[c4] a second application keeps existing rows :: not checked"
fi
suite core "$HERE/core/core_only.sql"

# --- Result -------------------------------------------------------------------

echo "# total: $total checks, $passed passed, $failed failed"
[ "$failed" -eq 0 ]
