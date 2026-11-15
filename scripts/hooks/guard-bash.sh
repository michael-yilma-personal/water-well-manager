#!/bin/bash
#
# Claude Code PreToolUse hook for Bash. Reads the hook JSON on stdin.
#
# THIS IS A TRIPWIRE, NOT A SECURITY BOUNDARY. It reads the text of a command
# line and stops the ordinary ways of doing what the workflow forbids. A
# command built to get past it will get past it. The real controls are branch
# protection on GitHub, a working copy that is not linked to production, and
# the catalog check in CI.
#
# Outcomes:
#   allow  exit 0, no output.
#   deny   things an agent never does on its own: push to main or master (by
#          name, by a wildcard or matching refspec, or a bare `git push` while
#          main or master is checked out), push --all / --mirror, force-push,
#          merge a pull request, move a ref or change branch protection or
#          rulesets through the GitHub API.
#   ask    things the owner approves each time: anything that names the
#          production Supabase project or is not provably local or staging
#          (supabase CLI, psql and the other Postgres clients, curl / wget /
#          HTTPie to Supabase), other changes through the GitHub API with
#          curl or wget, the management scripts, the e2e suites, test:*
#          package scripts, a shell or Python fed its program through a pipe,
#          and a command line too long or too deeply nested to analyse.
#   exit 2 fail closed: no interpreter, input that is not hook JSON, missing
#          or inconsistent configuration (no PROD_REF, STAGING_REF equal to
#          PROD_REF), or an analyser that crashed. Claude Code blocks the
#          command and shows the message.
#
# The analysis is in guard_bash.py next to this file (Python 3, standard
# library only); its header lists the rules and the known limits.
# Configuration: scripts/hooks/guard.conf.
#
# The shebang is /bin/bash, not `env bash`, and this wrapper uses shell
# builtins only, so it still starts and fails closed when PATH is empty.

set -u

HERE="${BASH_SOURCE[0]%/*}"
[ "$HERE" = "${BASH_SOURCE[0]}" ] && HERE="."
IMPL="$HERE/guard_bash.py"

PYTHON="$(command -v python3 2>/dev/null || true)"
if [ -z "$PYTHON" ]; then
  echo "guard-bash: python3 was not found on PATH; the command is blocked." >&2
  exit 2
fi
if [ ! -f "$IMPL" ]; then
  echo "guard-bash: $IMPL is missing; the command is blocked." >&2
  exit 2
fi

# -I: ignore PYTHON* variables and the user's site directory. -S: skip site.
"$PYTHON" -I -S "$IMPL"
STATUS=$?
[ "$STATUS" -eq 0 ] && exit 0
if [ "$STATUS" -ne 2 ]; then
  echo "guard-bash: the analyser failed (exit $STATUS); the command is blocked." >&2
fi
exit 2
