#!/usr/bin/env bash
#
# Quality gates. The same commands run locally, from Claude Code hooks and in
# CI (.github/workflows/ci.yml), so a green gate means the same thing in all
# three places.
#
#   scripts/gate.sh quick   type check, unit tests, script tests, the check
#                           that every test file is run, migration and secret
#                           checks, the e2e target self-test, and the check
#                           that the working copy is not linked to production.
#                           A few minutes (the script tests are most of it).
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
# Without tsx in node_modules the unit tests cannot run and their gate is red;
# there is no fallback to `npm test` (RF-044).
#
# "every test file is run" (RF-042) is red when a file named like a test
# (*.test.*, *.spec.*, or anywhere under a __tests__/ directory), tracked or
# untracked and not git-ignored, matches neither glob above, so no gate
# command would run it. Each such file is named. Python files under e2e/ are
# exempt: they are run by their own commands, against staging. The gate is
# also red when git cannot list the files.
#
# "e2e targets staging only" runs `python3 e2e/target_selftest.py` (P0-3): no
# network; it checks that the e2e suites take their target from e2e/_target.py
# and that it refuses production. Red when the file is missing or exits
# non-zero.
#
# "working copy is not linked to production" (RF-059) reads PROD_REF from
# scripts/hooks/guard.conf and the Supabase link file
# supabase/.temp/project-ref. Red when any line of the link file is the
# production ref (RF-065): every non-empty line is compared, with whitespace
# of every kind (blanks, a Windows line ending, form feed, vertical tab) trimmed
# from both ends, a UTF-8 byte-order mark in front removed (RF-068), and
# without regard to case, so a second line, a blank first line or a trailing
# comment line cannot hide it. Checking out a branch that predates the workflow tooling puts that
# tracked link back. Green when the link file is absent, empty or holds no
# line equal to the production ref. Red when
# guard.conf cannot be read or sets no PROD_REF, or when the link file exists
# and cannot be read: the check cannot tell, and that is not a pass. It only
# reads the two files.
#
# GATE_UNIT_TEST_CMD is for the gate's own tests (scripts/gate.test.mjs) only:
# when it is set and not empty, the gate runs that command string in place of
# the unit-test command. Such a run never prints the plain green verdict
# (RF-055). Its last line, when every gate passed, is exactly
#   GATE GREEN (quick; unit tests REPLACED by GATE_UNIT_TEST_CMD - not a real run)
# (or "full;"), and any line of the replacement command's own output that
# holds the words GATE GREEN is marked as that command's output, so it cannot
# be read as the verdict. Never set the variable anywhere else: the Bash guard
# asks the owner when a command line sets it, and the Stop hook removes it
# before it runs the gate.
#
# Limits: a green gate says these checks passed, nothing more. The migration
# check is a static hint (the catalog check in CI is the authority) and the
# secret scan matches shapes. A test counts as executed when Node reports it
# as passed and its name is not the path of an existing file (Node reports a
# file that defines no test as one passing test named after the file). The
# "every test file is run" check compares names with the two globs; it does
# not ask Node which files it loaded.

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
  if [ -n "${GATE_UNIT_TEST_CMD:-}" ]; then
    # The gate's own tests only (see the header). pipefail keeps the command's status.
    bash -c "$GATE_UNIT_TEST_CMD" 2>&1 | sed 's/GATE GREEN/(output of GATE_UNIT_TEST_CMD, not a verdict) GATE GREEN/'
    return
  fi
  if [ ! -d node_modules/tsx ]; then
    echo "tsx is not installed (node_modules/tsx is missing), so the unit tests cannot run. Run npm ci."
    return 1
  fi
  node_tests "unit tests" "src/**/*.test.ts" --import tsx
}

script_tests() {
  node_tests "script tests" "scripts/**/*.test.mjs"
}

# RF-042: every file named like a test must be one a gate command runs.
stray_tests() {
  local list f base stray=0
  list="$(mktemp)" || return 1
  if ! git ls-files -co --exclude-standard -z > "$list" 2>/dev/null; then
    rm -f "$list"
    echo "git could not list the files here, so the check cannot tell which test files exist."
    return 1
  fi
  while IFS= read -r -d '' f; do
    [ -e "$f" ] || [ -L "$f" ] || continue   # tracked, deleted from disk
    base="${f##*/}"
    case "$base" in
      *.test.?*|*.spec.?*) ;;
      *) case "/$f" in */__tests__/*) ;; *) continue ;; esac ;;
    esac
    case "$f" in e2e/*.py) continue ;; esac                  # run by their own commands
    case "$f" in src/*.test.ts|scripts/*.test.mjs) continue ;; esac   # the two globs above
    if [ "$stray" -eq 0 ]; then
      echo "Named like a test, but no gate command runs it (the gate runs src/**/*.test.ts and scripts/**/*.test.mjs):"
    fi
    printf '  %s\n' "$f"
    stray=1
  done < <(sort -z -u "$list")
  rm -f "$list"
  return "$stray"
}

selftest() {
  if [ ! -f e2e/target_selftest.py ]; then
    echo "e2e/target_selftest.py is missing."
    return 1
  fi
  python3 e2e/target_selftest.py
}

# RF-059: the working copy must not be linked to the production project.
not_linked_to_production() {
  local conf=scripts/hooks/guard.conf link=supabase/.temp/project-ref prod verdict
  if [ ! -f "$conf" ] || [ ! -r "$conf" ]; then
    echo "$conf is missing or cannot be read, so the check cannot tell which project is production."
    return 1
  fi
  # The same reading as the Bash guard: KEY=value lines, the last one wins; a
  # `#` at the start of a line, or after blanks following a value, starts a
  # comment; quotes around the value and a Windows line ending are dropped.
  prod="$(awk '
    {
      sub(/\r$/, "")
      line = $0
      gsub(/^[ \t]+|[ \t]+$/, "", line)
      if (line == "" || line ~ /^#/) next
      i = index(line, "=")
      if (i == 0) next
      key = substr(line, 1, i - 1)
      gsub(/^[ \t]+|[ \t]+$/, "", key)
      if (key != "PROD_REF") next
      value = substr(line, i + 1)
      if (value ~ /^#/) value = ""
      sub(/[ \t]#.*$/, "", value)
      gsub(/^[ \t]+|[ \t]+$/, "", value)
      gsub(/^["\047]+|["\047]+$/, "", value)
      gsub(/^[ \t]+|[ \t]+$/, "", value)
      found = value
    }
    END { print tolower(found) }
  ' "$conf" 2>/dev/null)" || prod=""
  if [ -z "$prod" ]; then
    echo "$conf sets no PROD_REF, so the check cannot tell which project is production."
    return 1
  fi
  [ -e "$link" ] || return 0   # not linked to any project
  # RF-065: every non-empty line, trimmed, without regard to case.
  # RF-068: trimmed of every kind of whitespace (form feed and vertical tab
  # included) and of a UTF-8 byte-order mark in front of the text. LC_ALL=C
  # makes every awk read bytes; the class is spelled out because an old mawk
  # does not know [[:space:]].
  if ! verdict="$(LC_ALL=C awk -v prod="$prod" '
    BEGIN { bom = "\357\273\277" }
    {
      line = $0
      do {
        before = line
        gsub(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/, "", line)
        while (substr(line, 1, 3) == bom) line = substr(line, 4)
      } while (line != before)
      if (line != "" && tolower(line) == prod) found = 1
    }
    END { print (found ? "production" : "other") }
  ' "$link" 2>/dev/null)" || [ -z "$verdict" ]; then
    echo "$link exists and cannot be read, so the check cannot tell which project this working copy is linked to."
    return 1
  fi
  if [ "$verdict" = "production" ]; then
    echo "$link holds PROD_REF: this working copy is linked to the PRODUCTION project."
    echo "A branch that predates the workflow tooling was probably checked out. Go back to the working"
    echo "branch and ask the owner to link the working copy to staging again (docs/saas/WORKFLOW.md)."
    return 1
  fi
}

run "typecheck (tsc --noEmit)"      npm run --silent lint
run "unit tests (src)"              unit_tests
run "script tests (scripts)"        script_tests
run "every test file is run"        stray_tests
run "migrations: RLS on every table" node scripts/check-migrations.mjs
run "no secrets in tracked files"   scripts/check-secrets.sh
run "e2e targets staging only"      selftest
run "working copy is not linked to production" not_linked_to_production

if [ "$MODE" = "full" ]; then
  run "production build (vite)"     npm run --silent build
fi

echo
if [ -n "${GATE_UNIT_TEST_CMD:-}" ]; then
  echo "NOTE: GATE_UNIT_TEST_CMD is set; the real unit tests did NOT run. This is for the gate's own tests only."
fi
if [ ${#FAILED[@]} -gt 0 ]; then
  echo "GATE RED ($MODE): ${#FAILED[@]} failed - ${FAILED[*]}"
  exit 1
fi
if [ -n "${GATE_UNIT_TEST_CMD:-}" ]; then
  echo "GATE GREEN ($MODE; unit tests REPLACED by GATE_UNIT_TEST_CMD - not a real run)"
  exit 0
fi
echo "GATE GREEN ($MODE)"
