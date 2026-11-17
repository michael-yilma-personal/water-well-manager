#!/usr/bin/env bash
#
# Every record's operator name must match the account that authored it.
#
# These were two independent sources of truth once: `operator` came from a local
# picker on the device and `created_by` from the authenticated session, so a
# driller's work could be credited to someone else. The app now stamps the
# signed-in account, but this checks the invariant still holds - worth running
# after any change to how identity reaches a record.
#
# Usage (there is no default project: SUPABASE_PROJECT_REF is required):
#   SUPABASE_PROJECT_REF=<ref> scripts/check-attribution.sh [--fix]
#
#   SUPABASE_PROJECT_REF=<production ref> scripts/check-attribution.sh --production [--fix]
#     The production project (PROD_REF in scripts/hooks/guard.conf) is refused
#     (exit 2) unless --production is the FIRST argument.
#
# DRILL_SCRIPT_DRY_RUN=1 prints "would run against <ref>" and exits 0 after
# the target and argument checks, before any network call.

set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/lib/project-target.sh"
project_target "$@"
[ "$PROJECT_TARGET_SHIFT" -eq 1 ] && shift

if [ $# -gt 1 ] || { [ $# -eq 1 ] && [ "$1" != "--fix" ]; }; then
  echo "Stopped: unexpected argument. Usage: $0 [--production] [--fix]" >&2
  exit 2
fi

project_target_dry_run

TOKEN="$(security find-generic-password -s "Supabase CLI" -w 2>/dev/null || echo "${SUPABASE_ACCESS_TOKEN:-}")"
[ -z "$TOKEN" ] && { echo "Run 'supabase login' first." >&2; exit 1; }

run_sql() {
  curl -s -X POST "https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query" \
    -H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json" \
    --data "$(python3 -c 'import json,sys; print(json.dumps({"query": sys.argv[1]}))' "$1")"
}

MISMATCH="select p.name as should_be, r.operator as currently_says, count(*) as rows
            from public.pipe_records r join public.profiles p on p.id = r.created_by
           where r.operator is distinct from p.name group by 1,2 order by 3 desc;"

echo "Records whose operator disagrees with the authoring account:"
run_sql "$MISMATCH"
echo

if [ "${1:-}" = "--fix" ]; then
  run_sql "update public.pipe_records r set operator = p.name
             from public.profiles p
            where p.id = r.created_by and r.operator is distinct from p.name;" >/dev/null
  echo "Corrected. Remaining mismatches:"
  run_sql "select count(*) as rows_still_wrong
             from public.pipe_records r join public.profiles p on p.id = r.created_by
            where r.operator is distinct from p.name;"
else
  echo "Run with --fix to correct them."
fi
