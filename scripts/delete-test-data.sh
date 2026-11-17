#!/usr/bin/env bash
#
# Remove the seeded test accounts and everything they created.
#
# Order matters. boreholes.created_by, pipe_records.created_by and friends
# reference auth.users with NO ACTION, so deleting a user who still has drilling
# records fails with:
#
#   ERROR: 23503: update or delete on table "users" violates foreign key
#   constraint "boreholes_created_by_fkey"
#
# That constraint is deliberate - you should not be able to delete a driller and
# orphan the record of who drilled - so the data goes first, then the accounts.
#
# Usage (there is no default project: SUPABASE_PROJECT_REF is required):
#   SUPABASE_PROJECT_REF=<ref> scripts/delete-test-data.sh                       # dry run, shows what would go
#   SUPABASE_PROJECT_REF=<ref> scripts/delete-test-data.sh --yes                 # actually delete
#   SUPABASE_PROJECT_REF=<ref> scripts/delete-test-data.sh --yes a@example.com   # specific accounts
#
#   SUPABASE_PROJECT_REF=<production ref> scripts/delete-test-data.sh --production [--yes] [emails]
#     The production project (PROD_REF in scripts/hooks/guard.conf) is refused
#     (exit 2) unless --production is the FIRST argument.
#
# On every project, production included, this deletes only accounts whose
# email ends in @example.com. Any other address on the command line is
# refused (exit 2) before anything is read or deleted.
#
# Without --yes it only counts (a read-only query). DRILL_SCRIPT_DRY_RUN=1
# goes further: it prints "would run against <ref>" and exits 0 after the
# target and argument checks, before any network call.
#
# Requires: the Supabase CLI logged in (`supabase login`).

set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/lib/project-target.sh"
project_target "$@"
[ "$PROJECT_TARGET_SHIFT" -eq 1 ] && shift

CONFIRM=false
EMAILS=()

for arg in "$@"; do
  case "$arg" in
    --yes) CONFIRM=true ;;
    --production)
      echo "Stopped: --production must be the first argument." >&2
      exit 2 ;;
    -*)
      echo "Stopped: unknown option '$arg'. Usage: $0 [--production] [--yes] [name@example.com ...]" >&2
      exit 2 ;;
    *) EMAILS+=("$arg") ;;
  esac
done

# Only test accounts, on any project. The strict shape also keeps quotes and
# other SQL out of the list built below.
for e in ${EMAILS[@]+"${EMAILS[@]}"}; do
  if ! [[ "$e" =~ ^[A-Za-z0-9._+-]+@example\.com$ ]]; then
    echo "Stopped: this script deletes only @example.com test accounts; it will not touch the address given." >&2
    exit 2
  fi
done

if [ ${#EMAILS[@]} -eq 0 ]; then
  EMAILS=(driller1@example.com driller2@example.com admin1@example.com datalogger1@example.com supervisor1@example.com)
fi

project_target_dry_run

TOKEN="$(security find-generic-password -s "Supabase CLI" -w 2>/dev/null || echo "${SUPABASE_ACCESS_TOKEN:-}")"
if [ -z "$TOKEN" ]; then
  echo "No Supabase access token. Run 'supabase login', or set SUPABASE_ACCESS_TOKEN." >&2
  exit 1
fi

run_sql() {
  curl -s -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
    -H "Authorization: Bearer ${TOKEN}" \
    -H "Content-Type: application/json" \
    --data "$(python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1]}))' "$1")"
}

# Build a SQL list: 'a@b.com','c@d.com'
LIST=""
for e in "${EMAILS[@]}"; do
  LIST="${LIST}${LIST:+,}'${e}'"
done

echo "Project : ${PROJECT_REF}"
echo "Accounts: ${EMAILS[*]}"
echo

echo "--- what this would remove ---"
run_sql "select
  (select count(*) from public.pipe_records    where created_by in (select id from auth.users where email in (${LIST}))) as pipe_records,
  (select count(*) from public.drilling_events where created_by in (select id from auth.users where email in (${LIST}))) as events,
  (select count(*) from public.shift_logs      where created_by in (select id from auth.users where email in (${LIST}))) as shift_logs,
  (select count(*) from public.boreholes       where created_by in (select id from auth.users where email in (${LIST}))) as boreholes,
  (select count(*) from storage.objects        where bucket_id='drilling-photos' and (storage.foldername(name))[1] in (select id::text from auth.users where email in (${LIST}))) as photos,
  (select count(*) from auth.users             where email in (${LIST})) as accounts;"
echo

if [ "$CONFIRM" != true ]; then
  echo
  echo "Dry run. Re-run with --yes to delete."
  exit 0
fi

echo "--- deleting (children first, then accounts) ---"
run_sql "
  with victims as (select id from auth.users where email in (${LIST}))
  delete from storage.objects
   where bucket_id='drilling-photos'
     and (storage.foldername(name))[1] in (select id::text from victims);"

for tbl in pipe_records drilling_events shift_logs boreholes; do
  run_sql "delete from public.${tbl} where created_by in (select id from auth.users where email in (${LIST}));" >/dev/null
  echo "  cleared public.${tbl}"
done

run_sql "delete from auth.users where email in (${LIST});" >/dev/null
echo "  removed accounts"
echo

echo "--- remaining ---"
run_sql "select u.email, p.role from auth.users u left join public.profiles p on p.id = u.id order by u.email;"
echo
run_sql "select
  (select count(*) from public.boreholes) as boreholes,
  (select count(*) from public.pipe_records) as pipe_records,
  (select count(*) from storage.objects where bucket_id='drilling-photos') as photos;"
echo
echo "Done. Note the e2e suites (test:rls, test:sync, test:photos, test:dashboard,"
echo "test:newcrew) need these accounts and will fail until you seed new ones."
