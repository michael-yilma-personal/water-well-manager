# Sourced by the management scripts (create-user.sh, delete-test-data.sh,
# check-attribution.sh). Decides which Supabase project a script may talk to.
# It makes no network call and reads only scripts/hooks/guard.conf.
#
#   . "$(dirname "${BASH_SOURCE[0]}")/lib/project-target.sh"
#   project_target "$@"                       # sets PROJECT_REF, or exits 2
#   [ "$PROJECT_TARGET_SHIFT" -eq 1 ] && shift   # drop a leading --production
#   ... the script checks its own arguments ...
#   project_target_dry_run                    # exits 0 here when DRILL_SCRIPT_DRY_RUN=1
#   ... first network call ...
#
# Rules (each failure is one line on stderr and exit 2):
#   - there is no default project: SUPABASE_PROJECT_REF must be set, and be a
#     plain project ref (letters, digits, - and _);
#   - PROD_REF is read from scripts/hooks/guard.conf, in the format the guard
#     hook reads (KEY=value; a # at the start of a line, or after blanks
#     following a value, starts a comment). If it cannot be read, or is not a
#     plain ref, the script stops: it cannot tell staging from production;
#   - if SUPABASE_PROJECT_REF is PROD_REF (letter case ignored), the script
#     stops unless --production is its FIRST argument.
#
# DRILL_SCRIPT_DRY_RUN=1: project_target_dry_run prints
# "would run against <ref>" and exits 0. Scripts call it after every argument
# and target check and before anything that touches the network.

# The path is built from this file's own directory, which always exists: a
# missing scripts/hooks/ must reach the "cannot read PROD_REF" message below,
# not stop a `set -e` caller here with no message.
PROJECT_TARGET_CONF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../hooks/guard.conf"
PROJECT_TARGET_SHIFT=0
PROJECT_REF=""

project_target_trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# Print the value of PROD_REF in guard.conf (the last assignment wins); fail
# when the file cannot be read.
project_target_prod_ref() {
  local line key value found=""
  [ -f "$PROJECT_TARGET_CONF" ] && [ -r "$PROJECT_TARGET_CONF" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    line="$(project_target_trim "$line")"
    case "$line" in ''|'#'*) continue ;; *=*) ;; *) continue ;; esac
    key="$(project_target_trim "${line%%=*}")"
    [ "$key" = "PROD_REF" ] || continue
    value="${line#*=}"
    case "$value" in
      '#'*) value="" ;;
      *) value="${value%%[[:space:]]#*}" ;;
    esac
    value="$(project_target_trim "$value")"
    while :; do
      case "$value" in
        \"*|\'*) value="${value#?}" ;;
        *\"|*\') value="${value%?}" ;;
        *) break ;;
      esac
    done
    found="$(project_target_trim "$value")"
  done < "$PROJECT_TARGET_CONF"
  printf '%s' "$found"
}

project_target_fail() {
  echo "$1" >&2
  exit 2
}

project_target() {
  local ref="${SUPABASE_PROJECT_REF:-}" prod ref_lc prod_lc
  PROJECT_TARGET_SHIFT=0
  [ "${1:-}" = "--production" ] && PROJECT_TARGET_SHIFT=1

  prod="$(project_target_prod_ref)" \
    || project_target_fail "Stopped: cannot read PROD_REF from scripts/hooks/guard.conf, so this script cannot tell staging from production."
  case "$prod" in
    ''|*[!A-Za-z0-9_-]*)
      project_target_fail "Stopped: PROD_REF in scripts/hooks/guard.conf is missing or not a plain project ref, so this script cannot tell staging from production." ;;
  esac

  [ -n "$ref" ] \
    || project_target_fail "Stopped: SUPABASE_PROJECT_REF is not set. There is no default project; name the one to use, for example SUPABASE_PROJECT_REF=<staging ref> $0 ..."
  case "$ref" in
    *[!A-Za-z0-9_-]*)
      project_target_fail "Stopped: SUPABASE_PROJECT_REF is not a plain project ref (letters, digits, - and _)." ;;
  esac

  ref_lc="$(printf '%s' "$ref" | tr '[:upper:]' '[:lower:]')"
  prod_lc="$(printf '%s' "$prod" | tr '[:upper:]' '[:lower:]')"
  if [ "$ref_lc" = "$prod_lc" ] && [ "$PROJECT_TARGET_SHIFT" -ne 1 ]; then
    project_target_fail "Stopped: SUPABASE_PROJECT_REF is the PRODUCTION project. To run against production on purpose, pass --production as the first argument."
  fi
  PROJECT_REF="$ref"
}

project_target_dry_run() {
  if [ "${DRILL_SCRIPT_DRY_RUN:-}" = "1" ]; then
    echo "would run against ${PROJECT_REF}"
    exit 0
  fi
}
