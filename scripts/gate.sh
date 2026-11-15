#!/usr/bin/env bash
#
# Quality gates. The same commands run locally, from Claude Code hooks and in
# CI (.github/workflows/ci.yml), so a green gate means the same thing in all
# three places.
#
#   scripts/gate.sh quick   type check, unit tests, script tests, migration and
#                           secret checks. About a minute and a half (the
#                           script tests are most of it); safe to run often.
#   scripts/gate.sh full    quick + production build.
#   scripts/gate.sh         the same as quick.
#
# Any other argument is a usage error (exit 2): a mistyped mode must not run
# the quick gates and report green.
#
# Nothing here touches a network or a database. Tests that need a database are
# separate (see docs/saas/WORKFLOW.md) and never run against production.
#
# Exit status is non-zero if any gate fails. Every gate runs even after a
# failure, so one run shows everything that is red.
#
# The two test gates are run by this script, not through a package script, so
# that the set of tests cannot shrink quietly:
#   unit tests    node --import tsx --test "src/**/*.test.ts"
#   script tests  node --test "scripts/**/*.test.mjs"
# The globs are quoted so that Node expands them (the same on every shell).
# Either gate is red when a test fails, when no test file is found, or when no
# test was actually executed (every test skipped, or files that define none).
#
# Limits: a green gate says these checks passed, nothing more. The migration
# check is a static hint (the catalog check in CI is the authority) and the
# secret scan matches shapes. A test counts as executed when Node reports it
# as passed and its name is not the path of an existing file (Node reports a
# file that defines no test as one passing test named after the file). In a
# project without tsx in node_modules the unit tests cannot be run directly;
# there, and only there, the gate runs the project's own `npm test` instead.

set -uo pipefail
cd "$(dirname "$0")/.."

usage() {
  echo "Usage: $0 [quick|full]" >&2
  exit 2
}

[ $# -le 1 ] || usage
MODE="${1:-quick}"
case "$MODE" in
  quick|full) ;;
  *)
    echo "gate: unknown mode '$MODE'." >&2
    usage ;;
esac

FAILED=()

run() {
  local name="$1"; shift
  local out
  if out="$("$@" 2>&1)"; then
    echo "PASS  $name"
  else
    echo "FAIL  $name"
    echo "$out" | tail -40 | sed 's/^/      /'
    FAILED+=("$name")
  fi
}

# Run `node <options...> --test <glob>` and judge the TAP report.
#   node_tests <what> <glob> [node option]...
# NODE_TEST_CONTEXT is cleared so that a gate started from inside another
# `node --test` run still gets its own report.
node_tests() {
  local what="$1" glob="$2"; shift 2
  local out status total executed name
  out="$(env -u NODE_TEST_CONTEXT node "$@" --test --test-reporter=tap "$glob" 2>&1)"
  status=$?
  total="$(printf '%s\n' "$out" | sed -n 's/^# tests \([0-9][0-9]*\).*/\1/p' | tail -1)"
  if [ "$status" -ne 0 ]; then
    printf '%s\n' "$out" | grep -E '^ *not ok ' | head -30
    printf '%s\n' "$out" | grep -E '^# (tests|pass|fail) '
    if [ "${total:-0}" -eq 0 ]; then
      printf '%s\n' "$out" | tail -15
      echo "No $what were found by $glob."
    fi
    return 1
  fi
  if [ "${total:-0}" -eq 0 ]; then
    echo "No $what were found by $glob."
    return 1
  fi
  # Names of the tests that passed: an "ok" line that is neither skipped nor
  # todo, and is not followed by "type: 'suite'".
  executed=0
  while IFS= read -r name; do
    [ -f "$name" ] && continue   # a file that defines no test
    executed=$((executed + 1))
  done < <(printf '%s\n' "$out" | awk '
    function flush() { if (pending != "") print pending; pending = "" }
    /^ *ok [0-9]+ - / {
      flush()
      if ($0 ~ / # (SKIP|TODO)/) next
      pending = $0
      sub(/^ *ok [0-9]+ - /, "", pending)
      next
    }
    /^ *not ok / { flush(); next }
    /^ *type: .suite./ { pending = ""; next }
    END { flush() }
  ')
  if [ "$executed" -eq 0 ]; then
    echo "Node reported $total $what and executed none of them (all skipped, or files that define no test)."
    return 1
  fi
  echo "$executed $what passed."
}

unit_tests() {
  if [ -d node_modules/tsx ]; then
    node_tests "unit tests" "src/**/*.test.ts" --import tsx
  else
    npm test --silent
  fi
}

script_tests() {
  node_tests "script tests" "scripts/**/*.test.mjs"
}

run "typecheck (tsc --noEmit)"      npm run --silent lint
run "unit tests (src)"              unit_tests
run "script tests (scripts)"        script_tests
run "migrations: RLS on every table" node scripts/check-migrations.mjs
run "no secrets in tracked files"   scripts/check-secrets.sh

if [ "$MODE" = "full" ]; then
  run "production build (vite)"     npm run --silent build
fi

echo
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "GATE RED ($MODE): ${#FAILED[@]} failed - ${FAILED[*]}"
  exit 1
fi
echo "GATE GREEN ($MODE)"
