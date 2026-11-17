#!/usr/bin/env bash
#
# Check that an agent stayed inside its role's files.
#
#   scripts/check-scope.sh snapshot > /path/to/before.txt      (before the agent runs)
#   scripts/check-scope.sh developer      /path/to/before.txt  must not change test files
#   scripts/check-scope.sh test-engineer  /path/to/before.txt  must change only test files
#   scripts/check-scope.sh reviewer       /path/to/before.txt  must change nothing
#   ... [--allow <glob>]...   the Lead permits a protected path for this run (repeatable)
#
# Exit 0 = in scope, 1 = violation, 2 = usage error or the check could not run.
#
# A snapshot records:
#   - HEAD (commit and branch);
#   - the mode (regular, executable, symbolic link) and a content hash of every
#     file git would see - tracked files plus untracked ones that are not
#     ignored. Names are read NUL-separated, so a name git would print quoted
#     is seen like any other;
#   - the same for git-ignored files that sit on a protected path (for example
#     .claude/settings.local.json and node_modules/.package-lock.json);
#   - git's own configuration: every file in the hooks directory, the
#     repository config file, the exclude file (.git/info/exclude), the full
#     list of refs (git for-each-ref), and the Stop hook's last-green key
#     file (drill-stop-gate-green in the git directory).
# Comparing two snapshots shows exactly what one agent run added, changed or
# deleted, regardless of what was already uncommitted before it started.
#
# For every role:
#   - a changed HEAD (a commit, an amend, a reset, a branch switch), a changed
#     ref (a new branch or tag, a fetch, a stash), a changed git hook, a
#     changed repository config, a changed .git/info/exclude or a changed
#     Stop-gate key file is a violation. Nothing lifts it: agents do not
#     change git history, git's configuration or the gate's memory.
#   - a change under a protected path - the enforcement itself - is a
#     violation unless the Lead passes --allow with a glob that matches it.
#     In a glob, * and ? stay inside one path segment and ** crosses segments.
#     --allow lifts protected-path violations only.
#   - a test file is never "protected": wherever it lives it belongs to the
#     test engineer, and --allow does not open it to anyone else. Under
#     .claude/ and .github/ only *.test.<js or ts extension> files count as
#     tests; a name like x.spec.yml or a __tests__/ folder there is live
#     configuration and stays protected. CLAUDE.md is never a test file.
#   - docs/saas/ is the Lead's record (owner approvals live there): a change
#     under it is a protected-path violation for every role unless the Lead
#     passes --allow 'docs/saas/*'.
#
# Protected paths: .claude/**, .github/**, scripts/hooks/**, docs/saas/**,
# supabase/.temp/** (the link file the guard hook reads), scripts/gate.sh,
# scripts/check-*.sh, scripts/check-*.mjs, package.json, package-lock.json,
# tsconfig*.json, .npmrc, .mcp.json, .gitignore, netlify.toml, vite.config.ts,
# capacitor.config.ts, node_modules/.package-lock.json, and CLAUDE.md,
# CLAUDE.local.md or .gitattributes in any directory.
#
# Limits: it sees files, not behaviour; of the paths git ignores it sees only
# those on a protected path (and not those inside a directory that is ignored
# as a whole, other than .claude/, .github/, scripts/hooks/ and
# supabase/.temp/); a symbolic
# link is recorded by its target text, not by what it points at; a path
# containing a newline is recorded with the newline shown as \n; a file
# changed and changed back between the two snapshots is not seen. Keep the
# snapshot file outside the repository.
#
# CHECK_SCOPE_ROOT points the script at another repository (used by the tests).

set -uo pipefail
export LC_ALL=C

JS_EXT='(ts|tsx|mts|cts|js|jsx|mjs|cjs)'
TEST_RE="(\\.test\\.$JS_EXT\$|\\.spec\\.[^/]+\$|(^|/)__tests__/|^e2e/|^supabase/tests/)"
# Under these directories everything is live configuration except real test code.
CONFIG_DIR_RE='^(\.claude|\.github)/'
CONFIG_DIR_TEST_RE="(\\.test\\.$JS_EXT\$)"
INSTRUCTIONS_RE='(^|/)CLAUDE(\.local)?\.md$'
PROTECTED_RE='^(\.claude/|\.github/|scripts/hooks/|docs/saas/|supabase/\.temp/|(.*/)?\.gitattributes$|scripts/gate\.sh$|scripts/check-[^/]*\.(sh|mjs)$|package\.json$|package-lock\.json$|tsconfig[^/]*\.json$|\.npmrc$|\.mcp\.json$|\.gitignore$|netlify\.toml$|vite\.config\.ts$|capacitor\.config\.ts$|node_modules/\.package-lock\.json$|(.*/)?CLAUDE(\.local)?\.md$)'
HEAD_KEY='//HEAD'
GIT_KEY_PREFIX='//git/'
REFS_KEY='//git/refs'
CONFIG_KEY='//git/config'
EXCLUDE_KEY='//git/info/exclude'
STOP_KEY='//git/drill-stop-gate-green'
HOOK_KEY_PREFIX='//git/hooks/'
IGNORED_LOCK='node_modules/.package-lock.json'

usage() {
  echo "Usage: $0 snapshot | $0 developer|test-engineer|reviewer <snapshot-file> [--allow <glob>]..." >&2
  exit 2
}

# --- arguments ---------------------------------------------------------------
ROLE=""
BEFORE=""
ALLOW=()
while [ $# -gt 0 ]; do
  case "$1" in
    --allow)
      [ $# -ge 2 ] || usage
      ALLOW+=("$2"); shift 2 ;;
    --allow=*)
      ALLOW+=("${1#--allow=}"); shift ;;
    -*)
      usage ;;
    *)
      if [ -z "$ROLE" ]; then ROLE="$1"
      elif [ -z "$BEFORE" ]; then BEFORE="$1"
      else usage
      fi
      shift ;;
  esac
done

case "$ROLE" in
  snapshot|developer|test-engineer|reviewer) ;;
  "") usage ;;
  *)
    echo "Unknown role '$ROLE'. Use developer, test-engineer or reviewer." >&2
    exit 2 ;;
esac

if [ "$ROLE" != "snapshot" ]; then
  [ -n "$BEFORE" ] || usage
  case "$BEFORE" in /*) ;; *) BEFORE="$PWD/$BEFORE" ;; esac
  if [ ! -f "$BEFORE" ]; then
    echo "Snapshot file not found: $BEFORE" >&2
    usage
  fi
fi

ROOT="${CHECK_SCOPE_ROOT:-$(dirname "$0")/..}"
cd "$ROOT" 2>/dev/null || { echo "check-scope: cannot enter $ROOT" >&2; exit 2; }
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "check-scope: $ROOT is not a git repository" >&2; exit 2; }

WORK="$(mktemp -d)" || exit 2
trap 'rm -rf "$WORK"' EXIT

# --- snapshot ------------------------------------------------------------------
# One line per file:  <mode>:<hash><TAB><path>
# One line for HEAD:  <commit> <branch><TAB>//HEAD
# git's own files:    <mode>:<hash><TAB>//git/hooks/<name>, <hash><TAB>//git/config,
#                     <hash><TAB>//git/refs

# Print "<mode>:<hash>" for one path, or nothing when it is neither a regular
# file nor a symbolic link.
entry() {
  local f="$1" mode hash
  if [ -L "$f" ]; then
    mode=120000
    hash="$(readlink "$f" | git hash-object --stdin)" || return 2
  elif [ -f "$f" ]; then
    if [ -x "$f" ]; then mode=100755; else mode=100644; fi
    hash="$(git hash-object --no-filters -- "$f")" || return 2
  else
    return 0   # a tracked file deleted from disk is simply absent
  fi
  [ -n "$hash" ] || return 2
  printf '%s:%s' "$mode" "$hash"
}

snapshot() {
  local commit branch f e shown hooks config common name exclude gitdir
  commit="$(git rev-parse --verify -q HEAD 2>/dev/null || echo none)"
  branch="$(git symbolic-ref -q HEAD 2>/dev/null || echo detached)"
  printf '%s %s\t%s\n' "$commit" "$branch" "$HEAD_KEY"

  # What git lists, plus ignored files on protected paths.
  git ls-files -co --exclude-standard -z > "$WORK/listed" || return 2
  git ls-files -o -i --exclude-standard -z -- .claude .github scripts/hooks supabase/.temp >> "$WORK/listed" || return 2
  git ls-files -o -i --exclude-standard --directory -z > "$WORK/ignored" || return 2
  while IFS= read -r -d '' f; do
    [[ "$f" =~ $PROTECTED_RE ]] && printf '%s\0' "$f" >> "$WORK/listed"
  done < "$WORK/ignored"
  printf '%s\0' "$IGNORED_LOCK" >> "$WORK/listed"

  sort -z -u "$WORK/listed" > "$WORK/paths" || return 2
  while IFS= read -r -d '' f; do
    [ -n "$f" ] || continue
    e="$(entry "$f")" || return 2
    [ -n "$e" ] || continue
    shown="${f//$'\n'/\\n}"
    printf '%s\t%s\n' "$e" "$shown"
  done < "$WORK/paths"

  # git's own configuration.
  hooks="$(git rev-parse --git-path hooks 2>/dev/null)" || return 2
  if [ -d "$hooks" ]; then
    for f in "$hooks"/* "$hooks"/.[!.]*; do
      [ -e "$f" ] || [ -L "$f" ] || continue
      e="$(entry "$f")" || return 2
      [ -n "$e" ] || continue
      name="${f##*/}"
      printf '%s\t%s%s\n' "$e" "$HOOK_KEY_PREFIX" "${name//$'\n'/\\n}"
    done
  fi
  common="$(git rev-parse --git-common-dir 2>/dev/null)" || return 2
  config="$common/config"
  if [ -f "$config" ]; then
    printf '%s\t%s\n' "$(git hash-object --no-filters -- "$config")" "$CONFIG_KEY"
  else
    printf 'none\t%s\n' "$CONFIG_KEY"
  fi
  exclude="$(git rev-parse --git-path info/exclude 2>/dev/null)" || return 2
  if [ -f "$exclude" ]; then
    printf '%s\t%s\n' "$(git hash-object --no-filters -- "$exclude")" "$EXCLUDE_KEY"
  else
    printf 'none\t%s\n' "$EXCLUDE_KEY"
  fi
  # The Stop hook's memory of the last green tree (scripts/hooks/stop-gate.sh).
  gitdir="$(git rev-parse --absolute-git-dir 2>/dev/null)" || return 2
  if [ -f "$gitdir/drill-stop-gate-green" ]; then
    printf '%s\t%s\n' "$(git hash-object --no-filters -- "$gitdir/drill-stop-gate-green")" "$STOP_KEY"
  else
    printf 'none\t%s\n' "$STOP_KEY"
  fi
  git for-each-ref > "$WORK/refs" || return 2
  printf '%s\t%s\n' "$(git hash-object --stdin < "$WORK/refs")" "$REFS_KEY"
}

if [ "$ROLE" = "snapshot" ]; then
  snapshot > "$WORK/out" || { echo "check-scope: could not take the snapshot" >&2; exit 2; }
  cat "$WORK/out"
  exit 0
fi

for key in "$HEAD_KEY" "$REFS_KEY"; do
  if ! cut -f2- "$BEFORE" | grep -qxF -- "$key"; then
    echo "check-scope: $BEFORE was not written by this version of the script (no $key line); take a new snapshot." >&2
    exit 2
  fi
done
snapshot > "$WORK/now" || { echo "check-scope: could not read the current state" >&2; exit 2; }

# Lines present in only one snapshot are files added, changed or deleted.
sort "$BEFORE" "$WORK/now" | uniq -u | cut -f2- | sort -u > "$WORK/changed"

# --- globs for --allow ---------------------------------------------------------
glob_to_regex() {
  local glob="$1" out="" i=0 c
  while [ "$i" -lt "${#glob}" ]; do
    c="${glob:$i:1}"
    case "$c" in
      '*')
        if [ "${glob:$((i + 1)):1}" = '*' ]; then out+='.*'; i=$((i + 1)); else out+='[^/]*'; fi ;;
      '?') out+='[^/]' ;;
      '.'|'^'|'$'|'+'|'('|')'|'{'|'}'|'|'|'['|']'|'\') out+="\\$c" ;;
      *) out+="$c" ;;
    esac
    i=$((i + 1))
  done
  printf '^%s$' "$out"
}
ALLOW_RE=()
for glob in ${ALLOW[@]+"${ALLOW[@]}"}; do
  ALLOW_RE+=("$(glob_to_regex "$glob")")
done

allowed() {
  local re
  for re in ${ALLOW_RE[@]+"${ALLOW_RE[@]}"}; do
    [[ "$1" =~ $re ]] && return 0
  done
  return 1
}

# Is this path a test file (the test engineer's), as opposed to protected or
# application code?
is_test_path() {
  [[ "$1" =~ $INSTRUCTIONS_RE ]] && return 1
  if [[ "$1" =~ $CONFIG_DIR_RE ]]; then
    [[ "$1" =~ $CONFIG_DIR_TEST_RE ]]
    return
  fi
  [[ "$1" =~ $TEST_RE ]]
}

# --- classify ------------------------------------------------------------------
HEAD_CHANGED=0
GIT_CHANGED=()
PROTECTED=()
BAD=()
COUNT=0

while IFS= read -r path; do
  [ -n "$path" ] || continue
  if [ "$path" = "$HEAD_KEY" ]; then
    HEAD_CHANGED=1
    continue
  fi
  case "$path" in
    "$REFS_KEY")           GIT_CHANGED+=("refs (a branch, tag, remote-tracking ref or stash was added, moved or deleted)"); continue ;;
    "$CONFIG_KEY")         GIT_CHANGED+=(".git/config"); continue ;;
    "$EXCLUDE_KEY")        GIT_CHANGED+=(".git/info/exclude (it hides files from git, and so from this check)"); continue ;;
    "$STOP_KEY")           GIT_CHANGED+=(".git/drill-stop-gate-green (the Stop hook's record of the last green gate)"); continue ;;
    "$HOOK_KEY_PREFIX"*)   GIT_CHANGED+=(".git/hooks/${path#"$HOOK_KEY_PREFIX"}"); continue ;;
    "$GIT_KEY_PREFIX"*)    GIT_CHANGED+=("${path#//}"); continue ;;
  esac
  COUNT=$((COUNT + 1))
  is_test=0
  is_test_path "$path" && is_test=1

  if [ "$is_test" -eq 0 ] && [[ "$path" =~ $PROTECTED_RE ]]; then
    allowed "$path" || PROTECTED+=("$path")
    continue   # an allowed protected path is permitted for any role
  fi

  case "$ROLE" in
    developer)     [ "$is_test" -eq 1 ] && BAD+=("$path") ;;
    test-engineer) [ "$is_test" -eq 0 ] && BAD+=("$path") ;;
    reviewer)      BAD+=("$path") ;;
  esac
done < "$WORK/changed"

case "$ROLE" in
  developer)     MSG="The developer changed test files" ;;
  test-engineer) MSG="The test engineer changed non-test files" ;;
  reviewer)      MSG="The reviewer changed files" ;;
esac

# --- report --------------------------------------------------------------------
STATUS=0
if [ "$HEAD_CHANGED" -eq 1 ]; then
  echo "SCOPE VIOLATION: HEAD changed during the run (a commit, amend, reset or branch switch). Agents do not change git history."
  STATUS=1
fi
if [ ${#GIT_CHANGED[@]} -gt 0 ]; then
  echo "SCOPE VIOLATION: git's own state changed during the run (--allow does not lift this). Agents do not change refs, git hooks, the repository config, the exclude file or the Stop-gate key file:"
  printf '  %s\n' "${GIT_CHANGED[@]}"
  STATUS=1
fi
if [ ${#PROTECTED[@]} -gt 0 ]; then
  echo "SCOPE VIOLATION: protected paths changed (the Lead may permit one with --allow <glob>):"
  printf '  %s\n' "${PROTECTED[@]}"
  STATUS=1
fi
if [ ${#BAD[@]} -gt 0 ]; then
  echo "SCOPE VIOLATION: $MSG:"
  printf '  %s\n' "${BAD[@]}"
  STATUS=1
fi
if [ "$STATUS" -eq 0 ]; then
  echo "Scope OK for $ROLE ($COUNT file(s) changed, all permitted)."
fi
exit "$STATUS"
