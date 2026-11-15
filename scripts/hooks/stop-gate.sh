#!/usr/bin/env bash
#
# Claude Code Stop hook. Reads the hook JSON on stdin.
#
# On every branch except main and master - a detached HEAD included - a turn
# may not end with the quick gate red without saying so: the first attempt to
# stop is blocked and the gate output is handed back. The second attempt goes
# through (stop_hook_active), so a genuine blocker can still be escalated to
# the owner; this cannot loop.
#
# On main and master it does nothing, so ordinary work there is unaffected.
#
# The gate is skipped when the working tree is byte-identical to the one the
# gate last passed on, so a turn that changed nothing costs a fraction of a
# second instead of a full gate run. The state is identified by the HEAD
# commit, `git status --porcelain=v1 -z`, a hash of `git diff --binary HEAD`
# and the content hashes of the untracked files that are not ignored. The
# identifier of the last green state is kept in the git directory
# (drill-stop-gate-green), never in the working tree. Only a green result is
# remembered: a red gate runs again every time. If the state cannot be
# identified (not a repository, no commit yet, a git error) or changes while
# the gate runs, nothing is remembered and the gate simply runs.
#
# Limits: it runs for the main session only (subagents report to the Lead, who
# runs the gate), it allows the second stop by design, and it is only as good
# as scripts/gate.sh. Input it cannot read is treated as a first attempt, so a
# red gate still blocks. The skip does not see git-ignored files (node_modules,
# .env files) or anything outside the repository (the Node version, global
# tools): a change there alone does not trigger a new run. Deleting
# drill-stop-gate-green in the git directory forces one.

set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || { echo "stop-gate: cannot enter the project directory." >&2; exit 2; }

INPUT="$(cat)"
ACTIVE="false"
if command -v jq >/dev/null 2>&1; then
  ACTIVE="$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo false)"
elif printf '%s' "$INPUT" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  ACTIVE="true"
fi
[ "$ACTIVE" = "true" ] && exit 0

# Empty when HEAD is detached or this is not a repository: the gate still runs.
BRANCH="$(git symbolic-ref -q --short HEAD 2>/dev/null || true)"
case "$BRANCH" in
  main|master) exit 0 ;;
esac
WHERE="${BRANCH:-a detached HEAD}"

# Print an identifier of the current tree state, or fail when there is none.
tree_key() {
  local head diff status untracked
  head="$(git rev-parse --verify -q HEAD 2>/dev/null)" || return 1
  diff="$(git diff --binary HEAD 2>/dev/null | git hash-object --stdin; exit "${PIPESTATUS[0]}")" || return 1
  status="$(git status --porcelain=v1 -z 2>/dev/null | git hash-object --stdin; exit "${PIPESTATUS[0]}")" || return 1
  untracked="$(
    git ls-files -o --exclude-standard -z 2>/dev/null | while IFS= read -r -d '' f; do
      if [ -L "$f" ]; then
        printf 'link %s\n' "$(readlink "$f")"
      elif [ -f "$f" ]; then
        if [ -x "$f" ]; then printf 'x '; else printf '%s' '- '; fi
        git hash-object --no-filters -- "$f" 2>/dev/null || printf 'unreadable\n'
      fi
    done | git hash-object --stdin
    exit "${PIPESTATUS[0]}"
  )" || return 1
  printf 'quick-gate-v1\n%s\n%s\n%s\n%s\n' "$head" "$diff" "$status" "$untracked" | git hash-object --stdin
}

GREEN_FILE=""
KEY=""
if GIT_DIR_PATH="$(git rev-parse --absolute-git-dir 2>/dev/null)" && [ -d "$GIT_DIR_PATH" ]; then
  GREEN_FILE="$GIT_DIR_PATH/drill-stop-gate-green"
  KEY="$(tree_key 2>/dev/null)" || KEY=""
fi
if [ -n "$KEY" ] && [ -f "$GREEN_FILE" ] && [ "$(cat "$GREEN_FILE" 2>/dev/null)" = "$KEY" ]; then
  exit 0   # nothing changed since the gate last passed
fi

if OUT="$(scripts/gate.sh quick 2>&1)"; then
  if [ -n "$KEY" ] && [ "$(tree_key 2>/dev/null)" = "$KEY" ]; then
    printf '%s\n' "$KEY" > "$GREEN_FILE" 2>/dev/null || true
  fi
  exit 0
fi

REASON="The quick gate is red on $WHERE. Fix it, or if it is a genuine blocker record it in docs/saas/IMPLEMENTATION_STATUS.md and tell the owner plainly that the gate is red.

$OUT"

if command -v jq >/dev/null 2>&1 && jq -n --arg r "$REASON" '{decision:"block",reason:$r}'; then
  exit 0
fi
printf '%s\n' "$REASON" >&2
exit 2
