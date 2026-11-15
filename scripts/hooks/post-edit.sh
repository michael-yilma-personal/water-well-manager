#!/usr/bin/env bash
#
# Claude Code PostToolUse hook for Write|Edit. Reads the hook JSON on stdin.
#
# Runs the one cheap check that matches the file just edited and hands a
# failure back to the agent as context. It never blocks: a file is often
# half-way through a change, and tests are red on purpose while the test
# engineer is writing them. The blocking check is scripts/gate.sh.

set -uo pipefail
cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}" || exit 0

FILE="$(jq -r '.tool_response.filePath // .tool_input.file_path // ""')"
NOTE=""

case "$FILE" in
  */supabase/migrations/*.sql)
    OUT="$(node scripts/check-migrations.mjs 2>&1)" || NOTE="Migration check failed after editing $(basename "$FILE"):
$OUT" ;;
  */.github/workflows/*|*/scripts/*.sh|*/scripts/hooks/*.sh)
    case "$FILE" in *.sh)
      OUT="$(bash -n "$FILE" 2>&1)" || NOTE="Shell syntax error in $(basename "$FILE"):
$OUT" ;;
    esac ;;
  */.claude/settings.json)
    OUT="$(jq -e . "$FILE" 2>&1 >/dev/null)" || NOTE=".claude/settings.json is not valid JSON; every hook in it is disabled until fixed:
$OUT" ;;
esac

if [ -n "$NOTE" ]; then
  jq -n --arg c "$NOTE" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$c}}'
fi
exit 0
