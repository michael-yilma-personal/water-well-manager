#!/usr/bin/env bash
#
# Create a real account and set its role.
#
# Signup is disabled on the project (deliberately - accounts are provisioned,
# not self-registered), so this goes in through the admin API rather than the
# public signup endpoint.
#
# The role is set here rather than at signup on purpose: the database ignores
# any client-supplied role, because letting an account choose its own would let
# anyone read every crew's data.
#
# Usage (there is no default project: SUPABASE_PROJECT_REF is required):
#   SUPABASE_PROJECT_REF=<ref> scripts/create-user.sh boss@company.com 'a-strong-password' Administrator "David Mutua" ADM-001
#   SUPABASE_PROJECT_REF=<ref> scripts/create-user.sh joe@company.com  'a-strong-password' Driller       "Joe Kamau"  DRL-110
#   SUPABASE_PROJECT_REF=<ref> scripts/create-user.sh ann@company.com  'a-strong-password' "Data Logger" "Ann Njeri"  LOG-201
#
#   SUPABASE_PROJECT_REF=<production ref> scripts/create-user.sh --production boss@company.com ...
#     The production project (PROD_REF in scripts/hooks/guard.conf) is refused
#     (exit 2) unless --production is the FIRST argument.
#
# Roles: Driller | Data Logger | Supervisor | Administrator
#
# The email, password, role, name and badge go into SQL text, so a value that
# contains a single quote, a backslash or a control character is refused
# (exit 2), not escaped. Pick a password and spell a name without them.
#
# DRILL_SCRIPT_DRY_RUN=1 prints "would run against <ref>" and exits 0 after
# the target and argument checks, before any network call.
#
# Requires the Supabase CLI logged in (`supabase login`).

set -euo pipefail

. "$(dirname "${BASH_SOURCE[0]}")/lib/project-target.sh"
project_target "$@"
[ "$PROJECT_TARGET_SHIFT" -eq 1 ] && shift

EMAIL="${1:-}"
PASSWORD="${2:-}"
ROLE="${3:-Driller}"
NAME="${4:-${EMAIL%%@*}}"
BADGE="${5:-}"

if [ -z "$EMAIL" ] || [ -z "$PASSWORD" ]; then
  echo "Usage: $0 <email> <password> [Driller|"Data Logger"|Supervisor|Administrator] [full name] [badge]" >&2
  exit 1
fi

case "$ROLE" in
  Driller|"Data Logger"|Supervisor|Administrator) ;;
  *) echo "Role must be Driller, Data Logger, Supervisor or Administrator (got '$ROLE')." >&2; exit 1 ;;
esac

# These values are interpolated into SQL below. Refuse, never escape.
check_sql_safe() {
  case "$2" in
    *"'"*|*\\*|*[[:cntrl:]]*)
      echo "Stopped: the $1 contains a single quote, a backslash or a control character, which this script does not send." >&2
      exit 2 ;;
  esac
}
check_sql_safe "email" "$EMAIL"
check_sql_safe "password" "$PASSWORD"
check_sql_safe "role" "$ROLE"
check_sql_safe "name" "$NAME"
check_sql_safe "badge" "$BADGE"

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

# crypt() lives in the extensions schema on Supabase.
echo "Creating ${EMAIL} ..."
run_sql "
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, created_at, updated_at,
  raw_app_meta_data, raw_user_meta_data,
  -- GoTrue writes empty strings here, never NULL, and its Go driver cannot
  -- scan NULL into them: leave these out and the row looks perfectly fine in
  -- SQL but every sign-in attempt fails with HTTP 500.
  confirmation_token, recovery_token, email_change,
  email_change_token_new, email_change_token_current,
  phone_change, phone_change_token, reauthentication_token
)
select
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
  '${EMAIL}',
  extensions.crypt('${PASSWORD}', extensions.gen_salt('bf')),
  now(), now(), now(),
  '{\"provider\":\"email\",\"providers\":[\"email\"]}'::jsonb,
  jsonb_build_object('name', '${NAME}', 'badge_number', '${BADGE}'),
  '', '', '', '', '', '', '', ''
-- auth.users has no unique index on email (only id and phone), so ON CONFLICT
-- cannot be used here; guard against a duplicate explicitly.
where not exists (select 1 from auth.users where email = '${EMAIL}');"

# The signup trigger creates the profile as a Driller; elevate out of band.
run_sql "update public.profiles
            set role = '${ROLE}', name = '${NAME}', badge_number = nullif('${BADGE}','')
          where id = (select id from auth.users where email = '${EMAIL}');" >/dev/null

echo "--- account ---"
run_sql "select u.email, p.name, p.role, p.badge_number
           from auth.users u join public.profiles p on p.id = u.id
          where u.email = '${EMAIL}';"
echo
echo "Sign in on the device (field app) or admin.html (dashboard) with that email."
