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

for tool in initdb pg_ctl postgres psql; do
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
