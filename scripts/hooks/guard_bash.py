#!/usr/bin/env python3
"""Analyser behind scripts/hooks/guard-bash.sh (Claude Code PreToolUse hook for Bash).

Reads the hook JSON on stdin and decides: allow (exit 0, no output), ask or
deny (exit 0, a PreToolUse decision on stdout), or fail closed (exit 2, a
message on stderr). Python 3 standard library only.

THIS IS A TRIPWIRE, NOT A SECURITY BOUNDARY. It reads the text of a command
line; it does not run a shell. It catches the ordinary ways of doing something
the workflow forbids and the honest mistakes. It cannot stop a command that is
built to get past it. The real controls are elsewhere: branch protection on
GitHub, a working copy that is not linked to production, and the catalog check
in CI.

What it does: splits the line into simple commands (; && || | & newlines,
subshells, $(...), backticks, <(...)), unquotes each word the way a shell
would, and looks inside:
  - `bash -c` / `sh -c` / `zsh -c` / `eval` strings;
  - what a shell is given on standard input: a here-document, a here-string
    (`bash <<< "..."`), also with `bash -s` or `bash /dev/stdin`;
  - the body of `function name { ...; }` and `name() { ...; }`;
  - wrappers and prefix words: env (with -C), time, nohup, command, builtin,
    exec, sudo, doas, xargs, nice, timeout, caffeinate, stdbuf, dotenv,
    corepack, npx and friends, find -exec, coproc, noglob, nocorrect,
    `repeat N`, and a leading `=` on the command word (zsh).
`<<` inside $(( )) or (( )) is arithmetic, not a here-document.

Then it applies the rules in docs/saas/IMPLEMENTATION_STATUS.md ("WF-4
acceptance criteria", Guard hook, rules 1-10) as extended by RF-025 to RF-035
in docs/saas/REVIEW_FINDINGS.md, by RF-043, RF-045 and RF-048 ("P0-6
acceptance criteria"), by RF-052 to RF-056 ("P0-9 acceptance criteria") and
by RF-059 and RF-061 ("P0-10 acceptance criteria"), by RF-063 and RF-065
("P0-11 acceptance criteria") and by RF-066 and RF-068 ("P0-12 acceptance
criteria").
A deny anywhere in the line wins over an ask; an ask wins over allow.

The effective directory of a command is the `cwd` of the hook JSON, then
every `cd` / `chdir` / `pushd` / `env -C` before it on the line (also as
`builtin cd`, `command cd`), with symlinks resolved. A directory the text
does not show is unknown, and an unknown directory never counts as this
project (RF-061): a hook `cwd` that is missing, empty or not an absolute
path; `cd "$DIR"`, `cd -`, `cd` alone, `popd`; a `cd` to a directory that
does not exist when the hook runs (the `cd` fails, or the directory is made
on the same line); the command of `sudo -D` / `--chdir`, of `find -execdir`
/ `-okdir`, and of `npx` / `bunx` / `pnpx` with `--prefix` / `--cwd`. The
one exception is the exact word `$CLAUDE_PROJECT_DIR` (or with braces) after
a cd: it is the project root, unless the line assigns that variable first.
"This checkout" below means: the project root, or a directory below it with
no `.git` (file or folder: a worktree, a submodule, a nested clone) between
it and the root.

After a git command that can change the working tree or create a checkout
(RF-059: checkout, switch, pull, merge, rebase, reset, stash, restore,
revert, cherry-pick, am, apply, bisect, worktree add, clone, submodule; RF-068:
read-tree, checkout-index, sparse-checkout) the link file, the suites and the
scripts on disk may no longer be the ones the hook read, in a subshell or a
`bash -c` string as well. For the rest of the line a Supabase CLI call that
would count as linked to staging, an e2e run, a test:* script and (RF-066) a
management script - also with the literal staging prefix: an older branch's
copy of it defaults to production - ask. `git checkout -b <new>` and `git switch -c <new>` with no start
point do not count; with a start point they do. The git commands themselves
stay allowed, and so does everything that never depended on the link or the
tree (a call that names the staging ref, --local, the e2e self-test ...).

The same holds (RF-063, RF-066) after every GitHub CLI call whose subcommand
is not known to leave the working tree alone: `gh pr checkout`, `gh co`,
`gh repo clone / sync / fork / create`, `gh issue develop`, `gh alias`,
`gh extension`, `gh codespace`, any alias or extension name, a subcommand
held in a variable. `gh pr close` counts too, in any form (RF-069): with
`-d` / `--delete-branch` it can switch to the default branch. Known to be
safe, and not counted: `gh pr view / list / checks / create / status / diff /
comment / edit / ready / review / reopen`; `gh issue` with anything except
`develop` (`gh issue close` stays safe); `gh run`, `gh workflow`,
`gh api`, `gh auth`, `gh secret`, `gh variable`, `gh search`, `gh status`,
`gh browse`, `gh label`, `gh release`, `gh cache` (but `gh run download` and
`gh release download` write files, and count); `gh repo view / list`;
`gh help`, and `gh` with no subcommand (`gh --version`). Global flags and
their values before the subcommand (`-R owner/repo`, `--repo x`) are skipped.
And after `hub`, which is read as git: `hub <subcommand>` counts when the git
subcommand would (clone and pull are among them), and so do
`hub pr checkout` and `hub sync`. The git push rules apply to `hub push` as
they do to `git push`.

A word that names a path under supabase/.temp (RF-065) - an argument, an
option value, a redirection target or source, relative or absolute, the bare
directory included, also inside a longer word such as `main:supabase/.temp/x`
or a string of inline code - means the link file may have been written or
replaced on this line, or is being handled by hand. From that word on, a
Supabase CLI call that would count as linked to staging asks. A read counts
too: the guard does not tell a read from a write. The word is looked for in
the command it stands in before that command is judged, so a `bash -c`
string that holds it anywhere asks for every such call in the string.
A word that holds `supabase/` followed anywhere by `{`, `*`, `?` or `[`
(RF-068) counts the same: the shell may expand it to that path
(`supabase/.t*/project-ref`, `supabase/.{temp,x}`). What it would match is
not looked at, so `ls supabase/migrations/*.sql` counts too.

Deny:
  - git push (and git subtree push) to main or master, by name, by full ref,
    by a wildcard or matching refspec, by `-c remote.<name>.push=`; --all,
    --mirror, --branches; any forced push. A push that names no branch, or
    names HEAD or @, is denied when the current branch is main or master: the
    branch is read from the .git directory of the directory the push runs in
    (`git -C` and a `cd` earlier in the line are followed), and a
    `git checkout` / `git switch` earlier in the line counts. A push with
    --dry-run (-n) changes nothing and is allowed.
  - gh pr merge; gh api with a mutating method on a path ending /merge or
    /merges, on /protection, /git/refs or /rulesets; the GraphQL mutations
    that merge, move a ref, commit to a branch or change protection rules
    (a query that only reads protection rules is allowed); curl, wget or
    HTTPie doing the same against api.github.com.
Ask:
  - the production ref anywhere in the line;
  - a supabase CLI call that is not provably local or staging. "Linked to
    staging" (RF-052) holds only when the link file of the project root is
    the staging ref AND the call's effective directory - `--workdir` replaces
    it - is in this checkout with no supabase/ folder of its own between it
    and the root: the CLI uses the link of the directory it runs in;
  - `supabase link` and `supabase unlink`, always (RF-061), also when the
    new target is staging: every "linked to staging" allowance rests on that
    link. Only --help / -h excuse them;
  - any supabase call with an argument held in a variable, or with a
    SUPABASE_* variable set in front of it (directly, with env, with export
    earlier in the line, or from a dotenv file) - SUPABASE_ACCESS_TOKEN
    excepted, which names no target;
  - even on staging (RF-043, RF-054): every `projects` / `orgs` call except
    `list` (create, delete, pause ...); `branches delete`, `storage rm`,
    `functions delete`, `secrets unset`; `migration down` and `db reset`
    without --local. Only `--help` / `-h` excuse a call (RF-056); `--version`
    excuses nothing except as the bare `supabase --version`;
  - psql, pg_dump, pg_restore, pg_dumpall, pg_basebackup, dropdb, createdb,
    vacuumdb, reindexdb, clusterdb without a literal local or staging target,
    or with any PG* variable set in front of them;
  - curl, wget, http or https (HTTPie) to a supabase.co, supabase.in or
    api.supabase.com host, or to a URL built from a SUPABASE variable, that
    is not provably staging; a URL containing `..` or `%` is never staging.
    The management API for the staging project (api.supabase.com
    /v1/projects/<staging ref>...) is allowed, with these exceptions, judged
    on the path after `.` and `..` segments are resolved (RF-056): a DELETE -
    or a method held in a variable - on the project itself (RF-043), and any
    request to its /pause endpoint (RF-054). Deleting staging test data stays
    allowed: REST deletes on the staging host, and SQL posted to
    /database/query, which is not inspected;
  - curl with -K / --config and a Supabase address on the line (RF-056): the
    file may hold the method or another address;
  - any other mutating curl, wget or HTTPie request to api.github.com;
  - a management script (RF-048), unless the call sets
    SUPABASE_PROJECT_REF=<staging ref> as a literal in front of the script
    (directly or through env) and does not pass --production. Sourced, or
    redirected or piped into a shell, it always asks. `bash -n` / `sh -n` /
    `-o noexec` on one is a syntax check and is allowed, unless a later `+n`
    or `+o noexec` switches it off again (RF-056). After a tree-changing
    git, gh or hub command on the same line it asks even with the staging
    prefix (RF-066). A dynamic word between
    `env` and the script (`env $EXTRA script`, `env X=$Y script`) asks: it
    may set SUPABASE_PROJECT_REF to another project (RF-056); the same word
    in front of a supabase CLI call asks too;
  - a command line that sets GATE_UNIT_TEST_CMD - in front of a command,
    through env, on its own, or with export / declare (RF-055): scripts/gate.sh
    would run that command in place of the unit tests;
  - a shell that reads its commands from a pipe or a redirected file;
  - Python whose script argument is a variable, a substitution or `{}`, or
    that reads its program from standard input (a pipe, a `<` redirection,
    `-`, xargs) - in every configuration (RF-053): it may be an e2e suite of
    another checkout or commit. A here-document or here-string is inline
    code and is not asked;
  - Python given a relative script while the effective directory is unknown
    (RF-061): the file may be an e2e suite of another checkout;
  - the e2e suites: a file under an e2e/ folder that is executed, or any
    argument that names a path under e2e/ given to an interpreter or runner
    (python, pytest, uv, poetry, pipenv, coverage, tox, nox, node, deno, a
    shell, ...); `python -m` with a module name, or `-m unittest` /
    `-m pytest` with an argument, that has an `e2e` part anywhere in its
    dotted name (RF-045, RF-061): `pkg.e2e.x` is the folder pkg/e2e of the
    directory the call runs in. While STAGING_REF is empty they
    always ask. Once it is set (RF-048, RF-053) a run is allowed only when
    the file resolves to <project root>/e2e/... and the effective directory
    is in this checkout: only the suites of this working tree are known to
    refuse production. `python3 e2e/target_selftest.py` from this project,
    that one file alone, is allowed in every configuration: it needs no
    network and the gate runs it;
  - test:* package scripts with any runner, npm-run-all included. While
    STAGING_REF is empty they always ask; once it is set they are allowed
    only when the effective directory is the project root itself (RF-053).
    The runner's own directory flag (--prefix, --dir, --cwd, -C) moves that
    directory; a workspace selector (-w, --workspace, --filter, -r) makes it
    unknown. With an npm_config_* variable (either case) set in front of the
    run, through env, or exported earlier in the line, they ask (RF-061);
  - a `git push` that names no branch when the directory it runs in is not
    known to the guard;
  - a command line longer than MAX_COMMAND characters or nested deeper than
    MAX_NESTING levels: it is not analysed at all.

Known limits (none of these is analysed):
  - the value of a variable: `B=main; git push origin "$B"`, `$CMD args`,
    `bash "$script"`, `SUPABASE_PROJECT_REF=<staging> $WRAPPER script` (only a
    dynamic word after `env` is treated as a possible assignment);
  - the directory checks read the file system as it is when the hook runs:
    a worktree or a supabase/ folder created earlier on the same command
    line is not seen, and the guard cannot know which link file the CLI
    itself would pick beyond the rule above. A tree-changing git command is
    seen only on the same command line (RF-059): after a checkout of an older
    branch in one command, the next command is judged by the files then on
    disk - on a branch that predates the tooling the guard itself is gone.
    The gate "working copy is not linked to production" is the backstop;
  - a tree-changing git command hidden from the text: a git alias, a
    subcommand held in a variable, a script or another tool that runs git
    (only gh and hub are read, RF-063, RF-066; other git front ends are
    not), or a known-safe gh subcommand that an alias of the same name has
    replaced;
  - `git rm`, `git mv`, `git clean` and `git lfs checkout` are not counted
    as tree-changing (RF-069): they cannot restore a tracked link file; they
    can only remove or move files, after which the later call fails;
  - a path under supabase/.temp that the text does not spell (RF-065): held
    in a variable, reached through a symlink, through a glob or brace list
    that does not follow the text `supabase/` (`sup*/.temp`, RF-068), written
    by a script, named in a here-document, or `cd supabase/.temp` in an
    earlier command; a directory option that supplies the `supabase` part
    (`tar -C supabase ...`, `env -C supabase ...`: only cd and its kin are
    followed); a path assembled inside inline code
    (`python3 -c "os.path.join('supabase', '.temp')"`) (RF-068);
  - `$CLAUDE_PROJECT_DIR` is taken to hold the project root the hook was
    given; an assignment through `read`, a loop or a sourced file is not seen;
  - SQL sent to staging (psql, /database/query, `supabase db ...` on a
    provably-staging target) is not inspected: it can delete anything there;
  - the management API beyond the two exceptions above: other requests to
    the staging project (restore, config changes, branch deletes) are
    allowed; `curl -K` with no Supabase address on the line is not seen;
  - brace and glob expansion, shell aliases, git aliases, a shell function
    defined in an earlier command of the session;
  - what a script, a package script other than test:*, a Makefile target or a
    file given to `wget -i` does when it runs; what inline code
    (`python3 -c`, `node -e`, a here-document given to Python) does;
  - commands run through tools not listed as wrappers (ssh, docker, watch ...);
  - a push to main spelled through `push.default`, an upstream that differs
    from the branch name, or GIT_DIR / GIT_WORK_TREE in the environment;
  - `supabase migration repair` is allowed on a provably-staging target like
    any other call (the tests pin this); it asks everywhere else;
  - a SUPABASE_PROJECT_REF exported earlier in the line does not count for a
    management script: only an assignment in front of the script itself does;
  - GitHub API routes other than the ones listed (contents, merge-upstream,
    workflow dispatch ...).

Configuration: scripts/hooks/guard.conf (PROD_REF=, STAGING_REF=; a `#` after
a value starts a comment) and the link file supabase/.temp/project-ref, both
under $CLAUDE_PROJECT_DIR, or under the repository this file lives in when
that variable is not set. A missing file, an empty PROD_REF, a ref that is not
a plain word, or a STAGING_REF equal to PROD_REF fails closed (exit 2).
"""

import json
import os
import posixpath
import re
import sys

MGMT_SCRIPTS = {'create-user.sh', 'delete-test-data.sh', 'check-attribution.sh'}
SHELLS = {'bash', 'sh', 'zsh', 'dash', 'ksh'}
RESERVED = {'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'noglob', 'nocorrect'}
STDIN_NAMES = {'-', '/dev/stdin', '/dev/fd/0', '/proc/self/fd/0'}
MAX_COMMAND = 100000  # characters; a longer command line is not analysed, it asks
MAX_NESTING = 60      # nested subshells / substitutions; deeper input asks
UNKNOWN = object()    # a branch or a directory the text does not show
META = set(' \t\r\n;|&()<>')
LOCAL_HOSTS = ('localhost', '127.0.0.1')

NAME_RE = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')
ASSIGN_RE = re.compile(r'^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?\+?=')
PYTHON_RE = re.compile(r'^(python|pypy)[0-9.]*$')
ANSI_C = {'n': '\n', 't': '\t', 'r': '\r', 'a': '\a', 'b': '\b', 'e': '\x1b', 'f': '\f', 'v': '\v', '0': '\0'}

MSG_PUSH = ('Workflow rule: never push to main or master, never push --all or --mirror, never force-push. '
            'Push the feature branch and open a pull request.')
MSG_MERGE = 'Workflow rule: pull requests are merged by the owner, never by an agent.'
MSG_PROTECTION = 'Workflow rule: branch protection is changed by the owner, never by an agent.'
MSG_PROD = 'This command names the PRODUCTION Supabase project. The owner approves each such command.'
MSG_SUPABASE = ('This Supabase CLI call is not provably local or aimed at staging '
                '(no --local, and the linked or named project is not the staging project).')
MSG_SUPABASE_ACCOUNT = 'This Supabase CLI call acts on the account (projects or organizations), not on the local stack.'
MSG_PG = 'This Postgres client call has no literal local or staging target; it may reach production.'
MSG_HTTP = 'This request goes to a Supabase host, or to a URL built from a SUPABASE variable, that is not provably staging.'
MSG_MGMT = ('This management script is not provably aimed at staging: SUPABASE_PROJECT_REF is not set to the '
            'literal staging ref in front of it, or --production is given.')
MSG_E2E = ('No staging project is configured (STAGING_REF is empty), so this e2e run is approved by the owner.')
MSG_TEST_SCRIPT = ('No staging project is configured (STAGING_REF is empty), so the test:* package scripts '
                   'are approved by the owner.')
MSG_SUPABASE_RESET = 'supabase db reset without --local wipes a remote database; the owner approves it even on staging.'
MSG_PROJECT_DELETE = ('This request may DELETE the staging project itself through the management API; '
                      'the owner approves it.')
MSG_UNREADABLE = 'The guard could not analyse this command line, so it is not allowed without the owner.'
MSG_TOO_BIG = ('This command line is longer or more deeply nested than the guard analyses, '
               'so it is not allowed without the owner.')
MSG_PUSH_UNKNOWN = ('This push names no branch, and the guard cannot tell which branch is checked out where it '
                    'runs. A push from main or master is never allowed.')
MSG_REF = 'Workflow rule: an agent never moves a branch or commits to one through the GitHub API.'
MSG_GH_HTTP = 'This request changes something through the GitHub API; the guard cannot tell what.'
MSG_SUPABASE_ENV = ('A SUPABASE_* variable is set in front of this Supabase CLI call, so the project it reaches '
                    'is not provably local or staging.')
MSG_SUPABASE_DYNAMIC = 'This Supabase CLI call has an argument held in a variable, so what it does is not provable.'
MSG_SUPABASE_DESTRUCTIVE = 'This Supabase CLI call deletes something; the owner approves it even on staging.'
MSG_STDIN_SHELL = 'A shell is reading its commands from a pipe or a file here; the guard cannot see them.'
MSG_PY_STDIN = ('Python is given no literal script here: its program or its arguments come from a pipe, a file '
                'or xargs, and may be an e2e suite.')
MSG_PY_DYNAMIC = 'The script this Python call runs is held in a variable or a placeholder, and may be an e2e suite.'
MSG_E2E_ELSEWHERE = ("This e2e run is not provably this project's own suite run from this checkout: the file does "
                     'not resolve to <project root>/e2e/, or the directory it runs in is outside the project, '
                     'inside a nested checkout or worktree, or not known. Only the suites of this working tree '
                     'are known to refuse production.')
MSG_TEST_ELSEWHERE = ('This test:* package script does not provably run in the project root, so it may be the '
                      'script of another checkout, whose suites are not known to refuse production.')
MSG_SUPABASE_DOWN = 'supabase migration down reverts migrations on a remote database; the owner approves it even on staging.'
MSG_PROJECT_PAUSE = 'This request may PAUSE the staging project through the management API; the owner approves it.'
MSG_CURL_CONFIG = ('curl reads more options from a file here (-K / --config) for a request to a Supabase host; '
                   'the guard cannot see the method or the address it ends up with.')
MSG_GATE_VAR = ('GATE_UNIT_TEST_CMD replaces the unit tests of scripts/gate.sh with another command; '
                'a gate run with it is not a real run, so the owner approves it.')
MSG_TREE_CHANGED = ('A git, gh or hub command earlier on this line can change the working tree or create a checkout '
                    '(checkout, switch, pull, merge, rebase, reset, stash, gh pr checkout ...), so the project this working copy '
                    'is linked to and the suites and scripts it holds are not known when this call runs. Run it as a '
                    'separate command.')
MSG_SUPABASE_LINK = ('supabase link / unlink changes the project this working copy is linked to; every '
                     '"linked to staging" allowance rests on that link, so the owner approves it.')
MSG_PY_UNKNOWN_DIR = ('Python is given a relative script here and the guard cannot tell which directory it runs '
                      'in, so it may be an e2e suite of another checkout.')
MSG_NPM_CONFIG = ('An npm_config_* variable is set in front of this test:* package script; it can point npm at '
                  'another package or another shell, so the owner approves it.')
MSG_LINK_TOUCHED = ('A word earlier on this line names a path under supabase/.temp, where the Supabase link '
                    'file lives, so the project this working copy is linked to is not known when this call '
                    'runs. Run it as a separate command.')
SELFTEST = 'e2e/target_selftest.py'  # needs no network; allowed even while STAGING_REF is empty
PROJECT_REF_VAR = 'SUPABASE_PROJECT_REF'  # the variable the management scripts read
GATE_VAR = 'GATE_UNIT_TEST_CMD'  # RF-055: scripts/gate.sh runs this instead of the unit tests
PROJECT_DIR_VAR = 'CLAUDE_PROJECT_DIR'  # RF-061: `cd "$CLAUDE_PROJECT_DIR"` is the project root
# RF-059: git subcommands that can change the working tree or create a checkout.
# `worktree` counts only as `worktree add`; `checkout -b <new>` and
# `switch -c <new>` with no start point do not count (see Guard.git_changes_tree).
# RF-068 adds read-tree, checkout-index and sparse-checkout.
GIT_TREE_CHANGING = {'checkout', 'switch', 'pull', 'merge', 'rebase', 'reset', 'stash', 'restore', 'revert',
                     'cherry-pick', 'am', 'apply', 'bisect', 'clone', 'submodule',
                     'read-tree', 'checkout-index', 'sparse-checkout'}
# RF-066: the gh subcommands known to leave the working tree alone. Every
# other gh invocation counts as tree-changing (see Guard.gh_changes_tree).
GH_SAFE_GROUPS = {'run', 'workflow', 'api', 'auth', 'secret', 'variable', 'search', 'status', 'browse', 'label',
                  'release', 'cache', 'help'}
GH_SAFE_PR = {'view', 'list', 'checks', 'create', 'status', 'diff', 'comment', 'edit', 'ready', 'review',
              'reopen'}
GH_SAFE_REPO = {'view', 'list'}
GH_DOWNLOADING = {'run', 'release'}  # `gh run download`, `gh release download` write files
# RF-065: a word that names supabase/.temp or a path below it, anywhere in the
# word (`./supabase/.temp`, `/abs/supabase/.temp/project-ref`,
# `main:supabase/.temp/x`, `of=supabase/.temp/x`). The file system here does
# not tell upper from lower case, so neither does this.
LINK_DIR_RE = re.compile(r'(?<![A-Za-z0-9_.-])supabase/+(?:\./+)*\.temp(?![A-Za-z0-9_.-])', re.I)
# RF-068: `supabase/` followed anywhere in the word by a brace or glob
# character: the shell may expand the word to a path under supabase/.temp.
LINK_GLOB_RE = re.compile(r'supabase/.*[{*?\[]', re.I | re.S)


class Assign(str):
    """The name of a NAME=value word in front of a command, with its value.

    value    the text after `=`, unquoted.
    literal  True when the value holds no variable or substitution and the
             assignment is a plain `NAME=value` (not `+=`, not an array element).
    """
    __slots__ = ('value', 'literal')

    def __new__(cls, name, value='', literal=False):
        self = str.__new__(cls, name)
        self.value = value
        self.literal = literal
        return self


def assignment(word):
    """The Assign of a NAME=value word, or None when the word is not an assignment."""
    m = ASSIGN_RE.match(word.text)
    if not m:
        return None
    plain = m.group(2) is None and not m.group(0).endswith('+=')
    return Assign(m.group(1), word.text[m.end():], plain and not word.dynamic)


class TooDeep(Exception):
    """The input nests deeper than MAX_NESTING."""


# ---------------------------------------------------------------------------
# Shell-word parsing
# ---------------------------------------------------------------------------

class Word(object):
    """One argument word after unquoting.

    text     the word as the command would receive it, except that variable
             references and command substitutions stay in source form
             ($NAME, ${NAME}, $(...)), so a string handed to `bash -c` can be
             parsed again.
    dynamic  True when any part comes from a variable or a substitution.
    vars     names of the variables referenced.
    bare     False when the word began with a quote.
    """
    __slots__ = ('text', 'dynamic', 'vars', 'bare')

    def __init__(self, text='', dynamic=False, names=None, bare=True):
        self.text = text
        self.dynamic = dynamic
        self.vars = names if names is not None else []
        self.bare = bare


class Cmd(object):
    """A simple command: its words, the command lists substituted into it, and its standard input.

    heredocs  bodies of here-documents and here-strings.
    stdin     the words of `< file` redirections.
    piped     True when the command reads from a pipe.
    redirs    the words other redirections point at (`> file`, `2>> file`, `&> file`).
    """
    __slots__ = ('words', 'subs', 'heredocs', 'keep', 'stdin', 'piped', 'redirs')

    def __init__(self):
        self.words = []
        self.subs = []
        self.heredocs = []
        self.keep = False
        self.stdin = []
        self.piped = False
        self.redirs = []


class Parser(object):
    """A lenient recursive parser. It never rejects input; odd syntax degrades to plain words."""

    def __init__(self, src, depth=0):
        self.s = src
        self.n = len(src)
        self.i = 0
        self.pending = []  # here-documents whose bodies start at the next newline
        self.depth = depth  # nesting so far, counted across nested parsers
        self.arith = 0     # > 0 inside $(( )) or (( )): `<<` is a shift there

    def parse_list(self, closer=None):
        """Parse commands up to the end, or up to an unmatched ')' when closer is ')'.

        Returns a list of ('cmd', Cmd) and ('sub', [nodes]) in source order.
        """
        self.depth += 1
        if self.depth > MAX_NESTING:
            raise TooDeep()
        try:
            return self.parse_commands(closer)
        finally:
            self.depth -= 1

    def parse_commands(self, closer):
        s = self.s
        nodes = []
        cur = Cmd()
        last_end = -1

        def flush(c):
            if c.words or c.subs or c.keep:
                nodes.append(('cmd', c))
            return Cmd()

        while self.i < self.n:
            c = s[self.i]
            if c == '\n':
                self.i += 1
                if self.pending:
                    self.read_heredocs()
                cur = flush(cur)
                continue
            if c in ' \t\r':
                self.i += 1
                continue
            if c == '\\' and s[self.i + 1:self.i + 2] == '\n':
                self.i += 2
                continue
            if c == '#':
                end = s.find('\n', self.i)
                self.i = self.n if end < 0 else end
                continue
            if c == ')':
                self.i += 1
                cur = flush(cur)
                if closer == ')':
                    return nodes
                continue
            if c == '(':
                self.i += 1
                if cur.words and last_end == self.i - 1 and cur.words[-1].text.endswith('='):
                    # name=(a b c): array elements are data, but substitutions inside them run.
                    for kind, node in self.parse_list(')'):
                        if kind == 'sub':
                            cur.subs.append(node)
                        else:
                            cur.subs.extend(node.subs)
                    continue
                arithmetic = not cur.words and s[self.i:self.i + 1] == '('
                cur = flush(cur)
                if arithmetic:  # (( ... )): no here-documents inside
                    self.arith += 1
                    try:
                        nodes.append(('sub', self.parse_list(')')))
                    finally:
                        self.arith -= 1
                else:
                    nodes.append(('sub', self.parse_list(')')))
                continue
            if c in ';|&':
                if s.startswith('&>', self.i):
                    self.i += 2
                    if s[self.i:self.i + 1] == '>':
                        self.i += 1
                    self.skip_target(cur)
                    continue
                start = self.i
                while self.i < self.n and s[self.i] in ';|&':
                    self.i += 1
                cur = flush(cur)
                if s[start:self.i] in ('|', '|&'):
                    cur.piped = True
                continue
            if c in '<>':
                if cur.words and last_end == self.i and cur.words[-1].text.isdigit() and not cur.words[-1].dynamic:
                    cur.words.pop()  # the file descriptor of 2>file
                if s.startswith('<<<', self.i) and not self.arith:
                    self.i += 3
                    self.skip_blanks()
                    if self.i < self.n and s[self.i] not in META:
                        cur.heredocs.append(self.read_word(cur).text)  # a here-string
                    cur.keep = True
                    continue
                if s.startswith('<<', self.i) and not self.arith:
                    self.i += 2
                    strip_tabs = s[self.i:self.i + 1] == '-'
                    if strip_tabs:
                        self.i += 1
                    self.skip_blanks()
                    start = self.i
                    delimiter = self.read_word(Cmd()).text if self.i < self.n and s[self.i] not in META else ''
                    raw = s[start:self.i]
                    quoted = any(ch in raw for ch in '\'"\\')
                    self.pending.append((delimiter, strip_tabs, quoted, cur))
                    cur.keep = True
                    continue
                if s[self.i + 1:self.i + 2] == '(':
                    self.i += 2
                    cur.subs.append(self.parse_list(')'))
                    cur.words.append(Word('<(...)', True))
                    last_end = self.i
                    continue
                start = self.i
                self.i += 1
                while self.i < self.n and s[self.i] in '<>&|':
                    self.i += 1
                if s[start:self.i] == '<' and not self.arith:
                    self.skip_blanks()
                    if self.i < self.n and s[self.i] not in META:
                        cur.stdin.append(self.read_word(cur))
                    cur.keep = True
                else:
                    self.skip_target(cur)
                continue
            before = self.i
            cur.words.append(self.read_word(cur))
            if self.i == before:
                self.i += 1
            last_end = self.i
        flush(cur)
        return nodes

    def skip_blanks(self):
        while self.i < self.n and self.s[self.i] in ' \t':
            self.i += 1

    def skip_target(self, cmd):
        """Take the word a redirection points at out of the arguments; substitutions
        inside it still count, and the word is kept in cmd.redirs (RF-065)."""
        self.skip_blanks()
        if self.i < self.n and self.s[self.i] not in META:
            cmd.redirs.append(self.read_word(cmd))
            cmd.keep = True

    def read_heredocs(self):
        s = self.s
        for delimiter, strip_tabs, quoted, cmd in self.pending:
            lines = []
            while self.i < self.n:
                end = s.find('\n', self.i)
                if end < 0:
                    end = self.n
                line = s[self.i:end]
                self.i = min(end + 1, self.n)
                if (line.lstrip('\t') if strip_tabs else line) == delimiter:
                    break
                lines.append(line)
            body = '\n'.join(lines)
            cmd.heredocs.append(body)
            if not quoted and ('$' in body or '`' in body):
                Parser(body, self.depth).read_dq(cmd, Word(), [], None)  # substitutions in the body run
        self.pending = []

    def read_word(self, cmd):
        s = self.s
        n = self.n
        word = Word(bare=s[self.i] not in '\'"')
        buf = []
        while self.i < n:
            c = s[self.i]
            if c in META:
                break
            if c == '\\':
                if self.i + 1 < n:
                    if s[self.i + 1] != '\n':
                        buf.append(s[self.i + 1])
                    self.i += 2
                else:
                    self.i += 1
                continue
            if c == "'":
                end = s.find("'", self.i + 1)
                if end < 0:
                    end = n
                buf.append(s[self.i + 1:end])
                self.i = min(end + 1, n)
                continue
            if c == '"':
                self.i += 1
                self.read_dq(cmd, word, buf, '"')
                continue
            if c == '$':
                self.read_dollar(cmd, word, buf, False)
                continue
            if c == '`':
                self.read_backtick(cmd, word, buf)
                continue
            buf.append(c)
            self.i += 1
        word.text = ''.join(buf)
        return word

    def read_dq(self, cmd, word, buf, terminator):
        """Read double-quoted text up to the terminator (or the end when it is None)."""
        s = self.s
        n = self.n
        while self.i < n:
            c = s[self.i]
            if terminator is not None and c == terminator:
                self.i += 1
                return
            if c == '\\' and self.i + 1 < n:
                d = s[self.i + 1]
                if d in '$`"\\':
                    buf.append(d)
                    self.i += 2
                elif d == '\n':
                    self.i += 2
                else:
                    buf.append('\\')
                    self.i += 1
                continue
            if c == '$':
                self.read_dollar(cmd, word, buf, True)
                continue
            if c == '`':
                self.read_backtick(cmd, word, buf)
                continue
            buf.append(c)
            self.i += 1

    def read_dollar(self, cmd, word, buf, in_dq):
        s = self.s
        n = self.n
        i = self.i
        nxt = s[i + 1:i + 2]
        if nxt == '(':
            self.i = i + 2
            if s[i + 2:i + 3] == '(':  # $(( ... )): no here-documents inside
                self.arith += 1
                try:
                    cmd.subs.append(self.parse_list(')'))
                finally:
                    self.arith -= 1
            else:
                cmd.subs.append(self.parse_list(')'))
            word.dynamic = True
            buf.append(s[i:self.i])
            return
        if nxt == '{':
            j = i + 2
            depth = 1
            while j < n and depth:
                ch = s[j]
                if ch == '\\':
                    j += 2
                    continue
                if ch == '{':
                    depth += 1
                elif ch == '}':
                    depth -= 1
                j += 1
            j = min(j, n)
            inner = s[i + 2:j - 1] if depth == 0 else s[i + 2:j]
            m = re.match(r'[!#]?([A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-])', inner)
            if m:
                word.vars.append(m.group(1))
            word.dynamic = True
            buf.append(s[i:j])
            self.i = j
            if '$(' in inner or '`' in inner:
                Parser(inner, self.depth).read_dq(cmd, Word(), [], None)
            return
        if not in_dq and nxt == "'":
            j = i + 2
            out = []
            while j < n and s[j] != "'":
                if s[j] == '\\' and j + 1 < n:
                    out.append(ANSI_C.get(s[j + 1], s[j + 1]))
                    j += 2
                else:
                    out.append(s[j])
                    j += 1
            buf.append(''.join(out))
            self.i = min(j + 1, n)
            return
        if not in_dq and nxt == '"':
            self.i = i + 1
            return
        m = NAME_RE.match(s, i + 1)
        if m:
            word.vars.append(m.group(0))
            word.dynamic = True
            buf.append('$' + m.group(0))
            self.i = m.end()
            return
        if nxt and nxt in '0123456789@*#?$!-':
            word.vars.append(nxt)
            word.dynamic = True
            buf.append('$' + nxt)
            self.i = i + 2
            return
        buf.append('$')
        self.i = i + 1

    def read_backtick(self, cmd, word, buf):
        s = self.s
        n = self.n
        i = self.i
        j = i + 1
        out = []
        while j < n and s[j] != '`':
            if s[j] == '\\' and j + 1 < n and s[j + 1] in '`\\$':
                out.append(s[j + 1])
                j += 2
            else:
                out.append(s[j])
                j += 1
        self.i = min(j + 1, n)
        cmd.subs.append(Parser(''.join(out), self.depth).parse_list())
        word.dynamic = True
        buf.append(s[i:self.i])


def split(args, short_val='', long_val=(), stop_first=False):
    """Separate options from positional words.

    short_val: short option letters that take a value (-Xvalue or -X value).
    long_val:  long options that take a value as the next word (--name=value always works).
    stop_first: stop at the first positional word and return the rest untouched.

    Returns (options, positionals, rest); options is a list of (name, value Word or None).
    """
    opts = []
    pos = []
    i = 0
    n = len(args)
    while i < n:
        a = args[i]
        t = a.text
        if t == '--':
            if stop_first:
                return opts, pos, args[i + 1:]
            pos.extend(args[i + 1:])
            break
        if t.startswith('--'):
            if '=' in t:
                key, value = t.split('=', 1)
                opts.append((key, Word(value, a.dynamic, a.vars)))
            elif t in long_val and i + 1 < n:
                opts.append((t, args[i + 1]))
                i += 1
            else:
                opts.append((t, None))
        elif t.startswith('-') and len(t) > 1:
            j = 1
            while j < len(t):
                ch = t[j]
                if ch in short_val:
                    value = t[j + 1:]
                    if value:
                        opts.append(('-' + ch, Word(value.lstrip('='), a.dynamic, a.vars)))
                    elif i + 1 < n:
                        opts.append(('-' + ch, args[i + 1]))
                        i += 1
                    else:
                        opts.append(('-' + ch, None))
                    break
                opts.append(('-' + ch, None))
                j += 1
        else:
            if stop_first:
                return opts, pos, args[i:]
            pos.append(a)
        i += 1
    return opts, pos, []


# ---------------------------------------------------------------------------
# Option tables (which options take a value)
# ---------------------------------------------------------------------------

GIT_LONG = {'--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source'}
PUSH_LONG = {'--push-option', '--repo', '--receive-pack', '--exec'}
GH_API_LONG = {'--method', '--header', '--raw-field', '--field', '--input', '--jq', '--template', '--cache',
               '--hostname', '--preview'}
# GraphQL mutations, lower case, matched as a substring of any word of a `gh api graphql` call.
GH_MERGE_MUTATIONS = ('mergepullrequest', 'enablepullrequestautomerge', 'mergebranch')
GH_REF_MUTATIONS = ('updateref', 'createcommitonbranch', 'createref', 'deleteref')
GH_PROTECTION_MUTATIONS = ('createbranchprotectionrule', 'updatebranchprotectionrule', 'deletebranchprotectionrule',
                           'createrepositoryruleset', 'updaterepositoryruleset', 'deleterepositoryruleset')

SUPABASE_SHORT = 'opsfjx'
SUPABASE_LONG = {
    '--workdir', '--dns-resolver', '--network-id', '--output', '--profile', '--project-ref', '--db-url',
    '--password', '--schema', '--file', '--status', '--env-file', '--import-map', '--jobs', '--region',
    '--org-id', '--db-password', '--size', '--lang', '--template', '--level', '--fail-on', '--exclude',
    '--version', '--last', '--from', '--to', '--query', '--branch', '--token', '--name', '--project-id',
}
# Deleting calls: asked even when the target is provably staging. A non-local
# `db reset` asks too (RF-043, handled next to these in c_supabase).
# `migration repair` is not here: the tests pin it as allowed on staging.
SUPABASE_DESTRUCTIVE = (['projects', 'delete'], ['branches', 'delete'], ['storage', 'rm'],
                        ['functions', 'delete'], ['secrets', 'unset'])
SUPABASE_ENV_EXEMPT = {'SUPABASE_ACCESS_TOKEN'}  # a credential, not a target

PG_SHORT = {
    'psql': 'cdfhpUvoLFRTP',
    'pg_dump': 'dfFjnNtTEhpUSZe',
    'pg_restore': 'dfFIjLnNPStThpU',
    'pg_dumpall': 'dfFhpUlSE',
    'pg_basebackup': 'DFrtTXZcldhpsUS',
    'dropdb': 'hpU',
    'createdb': 'DElOSThpU',
    'vacuumdb': 'djnNPthpU',
    'reindexdb': 'dijSthpU',
    'clusterdb': 'dthpU',
}
PG_LONG = {
    '--host', '--dbname', '--port', '--username', '--command', '--file', '--variable', '--set', '--output',
    '--log-file', '--field-separator', '--record-separator', '--table-attr', '--pset', '--format', '--jobs',
    '--schema', '--exclude-schema', '--table', '--exclude-table', '--exclude-table-data', '--encoding',
    '--superuser', '--compress', '--role', '--section', '--lock-wait-timeout', '--extension', '--snapshot',
    '--use-list', '--index', '--function', '--trigger', '--database', '--exclude-database', '--filter',
    '--maintenance-db', '--owner', '--template', '--tablespace', '--locale', '--lc-collate', '--lc-ctype',
    '--strategy', '--pgdata', '--label', '--slot', '--checkpoint', '--wal-method', '--max-rate', '--parallel',
    '--target', '--tablespace-mapping', '--status-interval',
}
PG_DB_OPTIONS = {'-d', '--dbname', '--maintenance-db'}
PG_INFO_OPTIONS = {'--version', '--help', '-V', '-?'}

CURL_SHORT = 'HdXouAebcFwmTxKrEYyzCtQPDU'
CURL_LONG = {
    '--header', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json',
    '--request', '--output', '--output-dir', '--user', '--user-agent', '--referer', '--cookie', '--cookie-jar',
    '--form', '--form-string', '--write-out', '--max-time', '--connect-timeout', '--retry', '--retry-delay',
    '--retry-max-time', '--upload-file', '--proxy', '--preproxy', '--cacert', '--capath', '--cert',
    '--cert-type', '--key', '--key-type', '--pass', '--config', '--resolve', '--connect-to', '--range', '--url',
    '--oauth2-bearer', '--proto', '--proto-default', '--proto-redir', '--max-redirs', '--limit-rate',
    '--dump-header', '--stderr', '--trace', '--trace-ascii', '--ciphers', '--tls-max', '--unix-socket',
    '--abstract-unix-socket', '--interface', '--dns-servers', '--noproxy', '--proxy-user', '--proxy-header',
    '--aws-sigv4', '--max-filesize', '--speed-limit', '--speed-time', '--time-cond', '--continue-at',
    '--pinnedpubkey', '--socks4', '--socks4a', '--socks5', '--socks5-hostname', '--keepalive-time',
    '--expect100-timeout', '--happy-eyeballs-timeout-ms', '--create-file-mode', '--etag-save', '--etag-compare',
    '--hsts', '--alt-svc', '--request-target', '--quote', '--local-port', '--netrc-file', '--engine',
    '--delegation', '--login-options', '--service-name', '--tlsuser', '--tlspassword', '--rate', '--variable',
}
CURL_REDIRECTS = {'-x', '--proxy', '--preproxy', '--connect-to', '--resolve', '--request-target'}
CURL_BODY = {'-d', '-F', '-T', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii',
             '--json', '--form', '--form-string', '--upload-file'}

WGET_SHORT = 'OoaiPUtTweQBDARXlI'
WGET_LONG = {
    '--output-document', '--output-file', '--append-output', '--input-file', '--directory-prefix',
    '--user-agent', '--tries', '--timeout', '--wait', '--execute', '--header', '--post-data', '--post-file',
    '--method', '--body-data', '--body-file', '--user', '--password', '--http-user', '--http-password',
    '--referer', '--load-cookies', '--save-cookies', '--ca-certificate', '--certificate', '--private-key',
    '--quota', '--base', '--domains', '--exclude-domains', '--accept', '--reject', '--level', '--limit-rate',
    '--bind-address', '--dns-timeout', '--connect-timeout', '--read-timeout', '--waitretry',
}
WGET_BODY = {'--post-data', '--post-file', '--body-data', '--body-file'}

HTTPIE_SHORT = 'aAosp'
HTTPIE_LONG = {
    '--auth', '--auth-type', '--output', '--session', '--session-read-only', '--print', '--style', '--pretty',
    '--format-options', '--response-charset', '--response-mime', '--proxy', '--verify', '--cert', '--cert-key',
    '--cert-key-pass', '--timeout', '--max-redirects', '--max-headers', '--boundary', '--raw', '--ssl',
    '--ciphers', '--default-scheme',
}

# Runners that take a script or a command after `run` (uv run x.py, poetry run python x.py).
RUNNERS = ('uv', 'uvx', 'pipx', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye', 'conda')
# Other programs that execute the files they are given: asked when an argument is under e2e/.
E2E_PROGRAMS = ('coverage', 'tox', 'nox', 'unittest', 'playwright', 'deno', 'tsx', 'ts-node', 'ruby', 'perl',
                'php')


def package_name(spec):
    """supabase@latest -> supabase, @scope/tool@1.2 -> tool."""
    return posixpath.basename(re.sub(r'(?<=.)@[^/@]*$', '', spec))


def glob_matches(pattern, text):
    """True when a refspec pattern (only `*` is special) matches text."""
    return re.match('^' + '.*'.join(re.escape(part) for part in pattern.split('*')) + '$', text) is not None


def push_refspec(text):
    """(forced, destination is or includes main or master, destination is the current branch) for one refspec."""
    forced = text.startswith('+')
    spec = text.lstrip('+')
    if spec == ':':
        return forced, True, False  # the matching refspec: every branch both sides have
    if ':' in spec:
        src, dst = spec.split(':', 1)
        current = dst == '' and src in ('HEAD', '@')
    else:
        dst = spec
        current = spec in ('HEAD', '@')
    if '*' in dst:
        to_main = any(glob_matches(dst, name) for name in ('main', 'master', 'refs/heads/main', 'refs/heads/master'))
        return forced, to_main, False
    for prefix in ('refs/heads/', 'heads/'):
        if dst.startswith(prefix):
            dst = dst[len(prefix):]
            break
    return forced, dst in ('main', 'master'), current


def is_info(keys):
    return any(key in ('--version', '--help') for key in keys)


# ---------------------------------------------------------------------------
# The rules
# ---------------------------------------------------------------------------

class Guard(object):
    def __init__(self, prod, staging, link, project):
        self.prod = prod
        self.staging = staging
        self.link = link
        self.project = project
        self.root = os.path.realpath(project)  # the project root, symlinks resolved
        self.denies = []
        self.asks = []
        self.cmd = Cmd()      # the simple command being analysed (its pipe and redirections)
        self.env = set()      # variables assigned or exported earlier in the line
        self.switched = None  # branch after a `git checkout` / `git switch` earlier in the line
        self.tree_changed = False  # RF-059, RF-063: a tree-changing git, gh or hub command ran earlier in the line
        self.link_touched = False  # RF-065: a word earlier in the line names a path under supabase/.temp
        self.handlers = self.build_handlers()

    def deny(self, reason):
        if reason not in self.denies:
            self.denies.append(reason)

    def ask(self, reason):
        if reason not in self.asks:
            self.asks.append(reason)

    def e2e(self, cwd, path='.'):
        """Something under an e2e/ folder is run: path, read from the directory cwd.

        While STAGING_REF is empty it asks. Once it is set (RF-048, narrowed by
        RF-053) the run is allowed only when path resolves to <project root>/e2e
        or below it and cwd is inside this project and outside any nested
        checkout: only the suites of this working tree are known to refuse
        production.
        """
        if not self.staging:
            self.ask(MSG_E2E)
            return
        if self.tree_changed:
            self.ask(MSG_TREE_CHANGED)  # RF-059: the suites on disk may be another commit's
            return
        base = self.directory(cwd)
        if base is not None and self.in_checkout(base):
            real = os.path.realpath(os.path.normpath(os.path.join(base, path)))
            own = os.path.join(self.root, 'e2e')
            if real == own or real.startswith(own + os.sep):
                return
        self.ask(MSG_E2E_ELSEWHERE)

    def e2e_args(self, cwd, words):
        """Apply the e2e rule to every argument that names a path under e2e/; True when one does."""
        found = False
        for w in words:
            for text in self.names_e2e(cwd, w):
                self.e2e(cwd, text)
                found = True
        return found

    def test_script(self, cwd, assigns=()):
        """A test:* package script is run in cwd. While STAGING_REF is empty it asks;
        once it is set it is allowed only in the project root itself (RF-053),
        with no tree-changing git command earlier in the line (RF-059) and no
        npm_config_* variable set for it (RF-061)."""
        if any(n.lower().startswith('npm_config_') for n in list(assigns) + sorted(self.env)):
            self.ask(MSG_NPM_CONFIG)
        if not self.staging:
            self.ask(MSG_TEST_SCRIPT)
        elif self.tree_changed:
            self.ask(MSG_TREE_CHANGED)
        elif self.directory(cwd) != self.root:
            self.ask(MSG_TEST_ELSEWHERE)

    def e2e_module(self, cwd, dotted):
        """RF-061: a dotted module name is run. Every part that is `e2e` names an
        e2e/ folder, looked up from the directory the call runs in: only
        <project root>/e2e is this project's own. True when a part is e2e."""
        parts = dotted.split('.')
        found = False
        for k, part in enumerate(parts):
            if part.lower() == 'e2e':
                self.e2e(cwd, '/'.join(parts[:k + 1]))
                found = True
        return found

    def in_checkout(self, directory):
        """True when directory is the project root, or below it with no `.git`
        (file or folder: a worktree, a submodule, a nested clone) on the way up to the root."""
        if directory != self.root and not directory.startswith(self.root + os.sep):
            return False
        d = directory
        while d != self.root:
            if os.path.lexists(os.path.join(d, '.git')):
                return False
            d = os.path.dirname(d)
        return True

    def linked_here(self, cwd):
        """RF-052: True when a Supabase CLI call run in cwd uses the link of the
        project root: cwd is the root, or below it in this checkout with no
        supabase/ folder of its own on the way up to the root."""
        directory = self.directory(cwd)
        if directory is None or not self.in_checkout(directory):
            return False
        d = directory
        while d != self.root:
            if os.path.lexists(os.path.join(d, 'supabase')):
                return False
            d = os.path.dirname(d)
        return True

    def mgmt(self, assigns, args):
        """RF-048: a management script is run. Allowed only with a literal
        SUPABASE_PROJECT_REF=<staging ref> in front of it and no --production."""
        ref = None
        for a in assigns:
            if a == PROJECT_REF_VAR:
                ref = a  # the last one wins, as in a shell
        if (not self.staging or ref is None or not getattr(ref, 'literal', False) or ref.value != self.staging
                or any(w.text == '--production' for w in args)):
            self.ask(MSG_MGMT)
        if self.tree_changed:
            # RF-066: the script on disk may be an older branch's copy, which
            # defaults to production; the staging prefix proves nothing then.
            self.ask(MSG_TREE_CHANGED)

    def is_selftest(self, cwd, word):
        """True when word is exactly the e2e self-test of this project."""
        if word.dynamic or not cwd[0] or cwd[1] is None or word.text.startswith('/'):
            return False
        return posixpath.normpath(posixpath.join(cwd[1], word.text)) == SELFTEST

    def staging_endpoint(self, word):
        """The management API path below the staging project that a URL word
        addresses, with `.` and `..` segments resolved as the client resolves
        them: '' for the project itself, 'pause', 'database/query' ... None
        when the word is not an address of the staging project on that API."""
        if not self.staging:
            return None
        host, path, host_dynamic = self.url_parts(word)
        if host_dynamic or host != 'api.supabase.com':
            return None
        resolved = posixpath.normpath('/' + re.split(r'[?#]', path, 1)[0].lstrip('/'))
        prefix = '/v1/projects/' + self.staging
        if resolved == prefix:
            return ''
        if resolved.startswith(prefix + '/'):
            return resolved[len(prefix) + 1:]
        return None

    def staging_project_itself(self, word):
        """True when a URL word is the management API address of the staging project itself."""
        return self.staging_endpoint(word) == ''

    def staging_project_pause(self, word):
        """True when a URL word is the pause endpoint of the staging project (RF-054)."""
        return self.staging_endpoint(word) == 'pause'

    # --- walking the line ---------------------------------------------------

    def line(self, src, cwd, depth):
        """Analyse a command line; returns the working directory after it."""
        if depth > 12:
            self.ask(MSG_UNREADABLE)
            return cwd
        if self.prod in src:
            self.ask(MSG_PROD)  # rule 5
        outer = self.cmd
        try:
            return self.walk(Parser(src, depth).parse_list(), cwd, depth)
        finally:
            self.cmd = outer

    def walk(self, nodes, cwd, depth):
        for kind, node in nodes:
            if kind == 'sub':
                self.walk(node, cwd, depth)  # a subshell: its cd does not leak out
            else:
                for sub in node.subs:
                    self.walk(sub, cwd, depth)
                self.cmd = node
                if any(self.names_link_dir(cwd, w) for w in node.words + node.redirs + node.stdin):
                    self.link_touched = True  # RF-065: for this command and every later one
                cwd = self.simple(node.words, cwd, depth, node.heredocs)
        return cwd

    def simple(self, words, cwd, depth, heredocs=(), extra=()):
        """Apply the rules to one simple command; returns the working directory after it.

        extra: names of variables an outer wrapper set for this command (env X=1 cmd).
        """
        for w in words:
            if self.prod in w.text:
                self.ask(MSG_PROD)  # rule 5, after unquoting
        i = 0
        assigns = list(extra)
        while i < len(words):
            w = words[i]
            if w.bare and not w.dynamic:
                if w.text in RESERVED:
                    i += 1
                    continue
                if w.text == 'function':  # function name { ...; }
                    i += 2
                    continue
                if w.text == 'repeat':  # zsh: repeat N command
                    i += 2
                    continue
                if w.text == 'coproc':  # coproc command, or coproc NAME { ...; }
                    i += 2 if words[i + 2:i + 3] and words[i + 2].text == '{' else 1
                    continue
            found = assignment(w) if w.bare else None
            if found is not None:
                assigns.append(found)
                i += 1
                continue
            break
        words = words[i:]
        if any(a == GATE_VAR for a in assigns):
            self.ask(MSG_GATE_VAR)  # RF-055: set in front of a command, through env, or on its own
        if not words:
            self.env.update(assigns)  # NAME=value on its own: it stays set for the rest of the line
            return cwd
        first = words[0]
        args = words[1:]
        text = first.text
        if first.bare and len(text) > 1 and text.startswith('='):
            text = text[1:]  # zsh: =name is the path of the command name
        name = posixpath.basename(text).lower()

        if name in MGMT_SCRIPTS:
            self.mgmt(assigns, args)  # rule 9
        if '/' in text and not first.dynamic and self.under_e2e(cwd, text):
            self.e2e(cwd, text)  # rule 9: a file under e2e/ executed directly
        elif name.endswith('.py') and self.under_e2e(cwd, text):
            self.e2e(cwd, text)

        handler = self.handlers.get(name)
        if handler is None and PYTHON_RE.match(name):
            handler = self.c_python
        if handler is None:
            return cwd
        result = handler(name, args, cwd, depth, assigns, heredocs)
        return cwd if result is None else result

    # --- working directory, as far as the text shows it -----------------------
    # cwd is (inside, path): inside is True while the directory is provably in
    # the project tree; path is relative to the project, absolute outside it,
    # or None when the text does not show where the command runs.

    def chdir(self, cwd, target):
        """The directory after `cd target` from cwd. `..` is taken off the text
        first, as the shell's `cd` does; then symlinks are resolved, so a link
        that leaves the project (or enters a worktree) is seen for what it is."""
        if not target.startswith('/'):
            base = self.directory(cwd)
            if base is None:
                return (False, None)
            target = os.path.join(base, target)
        real = os.path.realpath(os.path.normpath(target))
        # RF-061: a directory that is not there when the hook runs. The `cd`
        # fails (or the directory is made on this very line) and the commands
        # after it run somewhere the text does not show. The path is tested as
        # written too: `nope/..` only looks like its parent.
        if not os.path.isdir(target) or not os.path.isdir(real):
            return (False, None)
        if real == self.root:
            return (True, '')
        if real.startswith(self.root + os.sep):
            return (True, real[len(self.root) + 1:])
        return (False, real)

    def chdir_word(self, cwd, word):
        """The directory after `cd word` (or -C word); unknown when the word is not a literal path."""
        if word is None:
            return (False, None)
        if word.dynamic:
            # RF-061: the one variable whose value the hook knows, unless the
            # line itself has assigned it.
            if (word.text in ('$' + PROJECT_DIR_VAR, '${' + PROJECT_DIR_VAR + '}')
                    and PROJECT_DIR_VAR not in self.env and os.path.isdir(self.root)):
                return (True, '')
            return (False, None)
        if word.text in ('', '-') or word.text.startswith('~'):
            return (False, None)
        return self.chdir(cwd, word.text)

    def under_e2e(self, cwd, path):
        full = path if path.startswith('/') else posixpath.join(cwd[1] or '', path)
        return 'e2e' in posixpath.normpath(full).lower().split('/')

    def names_e2e(self, cwd, word):
        """The paths under e2e/ that an argument word (or the value of --option=value) names; empty when none."""
        if word.dynamic:
            return []
        texts = [word.text]
        if word.text.startswith('-') and '=' in word.text:
            texts.append(word.text.split('=', 1)[1])
        paths = [t.split('::')[0] for t in texts]
        return [p for p in paths if p and self.under_e2e(cwd, p)]

    def names_link_dir(self, cwd, word):
        """RF-065: True when a word names supabase/.temp or a path below it: in
        its text as written, or once the text is read as a path from cwd
        (`cd supabase && ... .temp/project-ref`, `supabase/x/../.temp`).
        RF-068: also when `supabase/` is followed anywhere in the word by a
        brace or glob character."""
        text = word.text
        if LINK_DIR_RE.search(text) or LINK_GLOB_RE.search(text):
            return True
        if not text or '\0' in text:
            return False
        full = posixpath.normpath(text if text.startswith('/') else posixpath.join(cwd[1] or '', text))
        if LINK_DIR_RE.search(full):
            return True
        # RF-068: `cd supabase && cp x .t*/project-ref`. Only for a relative
        # word: the directory part comes from the cd, the pattern from the word.
        return (not text.startswith('/') and re.search(r'[{*?\[]', text) is not None
                and LINK_GLOB_RE.search(full) is not None)

    def directory(self, cwd):
        """The absolute directory of cwd (symlinks resolved), or None when it is not known."""
        path = cwd[1]
        if path is None:
            return None
        if path.startswith('/'):
            return path
        return os.path.normpath(os.path.join(self.root, path))

    def branch_at(self, directory):
        """The branch checked out in the repository holding directory; None when there is none."""
        d = directory
        for _ in range(100):
            dot = os.path.join(d, '.git')
            head = None
            try:
                if os.path.isdir(dot):
                    head = os.path.join(dot, 'HEAD')
                elif os.path.isfile(dot):  # a worktree or a submodule: "gitdir: <path>"
                    with open(dot, 'r', encoding='utf-8', errors='replace') as handle:
                        pointer = handle.read(4096).strip()
                    if pointer.startswith('gitdir:'):
                        head = os.path.join(os.path.join(d, pointer[len('gitdir:'):].strip()), 'HEAD')
                if head is not None:
                    with open(head, 'r', encoding='utf-8', errors='replace') as handle:
                        m = re.match(r'ref:\s*refs/heads/(\S+)', handle.read(4096).strip())
                    return m.group(1) if m else None
            except OSError:
                return None
            parent = os.path.dirname(d)
            if parent == d:
                return None
            d = parent
        return None

    # --- handlers ---------------------------------------------------------------

    def build_handlers(self):
        table = {
            'cd': self.c_cd, 'chdir': self.c_cd, 'pushd': self.c_cd, 'popd': self.c_popd,
            'env': self.c_env, 'eval': self.c_eval, 'source': self.c_source, '.': self.c_source,
            'export': self.c_export, 'declare': self.c_export, 'typeset': self.c_export,
            'readonly': self.c_export, 'local': self.c_export,
            'find': self.c_find,
            'git': self.c_git, 'hub': self.c_hub, 'gh': self.c_gh, 'supabase': self.c_supabase,
            'curl': self.c_http, 'wget': self.c_http, 'http': self.c_httpie, 'https': self.c_httpie,
            'npm': self.c_package, 'yarn': self.c_package, 'pnpm': self.c_package, 'bun': self.c_package,
            'npx': self.c_npx, 'bunx': self.c_npx, 'pnpx': self.c_npx,
            'npm-run-all': self.c_run_all, 'run-s': self.c_run_all, 'run-p': self.c_run_all,
            'npm-run-all2': self.c_run_all, 'concurrently': self.c_concurrently,
            'node': self.c_node, 'pytest': self.c_pytest, 'py.test': self.c_pytest,
        }
        for shell in SHELLS:
            table[shell] = self.c_shell
        for client in PG_SHORT:
            table[client] = self.c_pg
        for wrapper in ('time', 'nohup', 'command', 'builtin', 'exec', 'sudo', 'doas', 'xargs', 'nice',
                        'timeout', 'gtimeout', 'caffeinate', 'stdbuf', 'gstdbuf', 'dotenv', 'corepack',
                        'setsid', 'unbuffer'):
            table[wrapper] = self.c_wrapper
        for runner in RUNNERS:
            table[runner] = self.c_runner
        for program in E2E_PROGRAMS:
            table[program] = self.c_e2e_program
        return table

    def c_cd(self, name, args, cwd, depth, assigns, heredocs):
        _, pos, _ = split(args)
        return self.chdir_word(cwd, pos[0] if pos else None)

    def c_popd(self, name, args, cwd, depth, assigns, heredocs):
        return (False, None)

    def c_export(self, name, args, cwd, depth, assigns, heredocs):
        for a in args:
            m = ASSIGN_RE.match(a.text)
            if m:
                self.env.add(m.group(1))
            if a.text == GATE_VAR or (m and m.group(1) == GATE_VAR):
                self.ask(MSG_GATE_VAR)  # RF-055: exported with or without a value
        return None

    def c_env(self, name, args, cwd, depth, assigns, heredocs):
        names = list(assigns)
        tainted = False  # RF-056: a dynamic word in front of the command may set any variable
        i = 0
        while i < len(args):
            t = args[i].text
            if args[i].dynamic:
                tainted = True
                if assignment(args[i]) is None and not t.startswith('-'):
                    i += 1  # it may expand to more assignments; the command is looked for after it
                    continue
            if t in ('-S', '--split-string'):
                self.line(' '.join(a.text for a in args[i + 1:]), cwd, depth + 1)
                return None
            if t.startswith('-S') or t.startswith('--split-string='):
                head = t.split('=', 1)[1] if t.startswith('--') else t[2:]
                self.line(' '.join([head] + [a.text for a in args[i + 1:]]), cwd, depth + 1)
                return None
            if t in ('-C', '--chdir'):
                cwd = self.chdir_word(cwd, args[i + 1] if i + 1 < len(args) else None)
                i += 2
                continue
            if t.startswith('--chdir='):
                cwd = self.chdir_word(cwd, Word(t.split('=', 1)[1], args[i].dynamic, args[i].vars))
                i += 1
                continue
            if t in ('-u', '--unset'):
                removed = args[i + 1].text if i + 1 < len(args) else ''
                names = [n for n in names if n != removed]
                i += 2
                continue
            if t == '-P':
                i += 2
                continue
            if t.startswith('--unset='):
                names = [n for n in names if n != t.split('=', 1)[1]]
                i += 1
                continue
            if t in ('-', '-i', '--ignore-environment'):
                names = []  # the command starts from an empty environment
                i += 1
                continue
            found = assignment(args[i])
            if found is not None:
                names.append(found)
                i += 1
                continue
            if t.startswith('-'):
                i += 1
                continue
            break
        if tainted:
            # The dynamic word may hold SUPABASE_PROJECT_REF=<another project> (or
            # any other SUPABASE_* target): what the command reads is not literal.
            names.append(Assign(PROJECT_REF_VAR, '', False))
        self.simple(args[i:], cwd, depth, heredocs, names)
        return None

    def c_wrapper(self, name, args, cwd, depth, assigns, heredocs):
        """Look through a command that runs another command."""
        names = list(assigns)
        if name == 'command':
            opts, _, rest = split(args, stop_first=True)
            if any(key in ('-v', '-V') for key, _ in opts):
                return None  # a lookup, not a run
        elif name == 'exec':
            _, _, rest = split(args, 'a', stop_first=True)
        elif name == 'time':
            _, _, rest = split(args, 'fo', {'--format', '--output'}, stop_first=True)
        elif name == 'nice':
            _, _, rest = split(args, 'n', {'--adjustment'}, stop_first=True)
        elif name in ('timeout', 'gtimeout'):
            _, _, rest = split(args, 'sk', {'--signal', '--kill-after'}, stop_first=True)
            rest = rest[1:]  # the duration
        elif name in ('sudo', 'doas'):
            opts, _, rest = split(args, 'ughpCDRTUrt', {'--user', '--group', '--host', '--prompt', '--chdir',
                                                         '--role', '--type', '--other-user', '--close-from'},
                                  stop_first=True)
            if any(key in ('-D', '--chdir') for key, _ in opts):
                cwd = (False, None)  # RF-061: the command runs in another directory
        elif name == 'xargs':
            _, _, rest = split(args, 'nIPLsEdaJRS', {'--max-args', '--max-procs', '--delimiter', '--arg-file',
                                                      '--max-chars'}, stop_first=True)
        elif name == 'caffeinate':
            _, _, rest = split(args, 'tw', stop_first=True)
        elif name in ('stdbuf', 'gstdbuf'):
            _, _, rest = split(args, 'ioe', {'--input', '--output', '--error'}, stop_first=True)
        elif name == 'dotenv':
            _, _, rest = split(args, 'evcop', stop_first=True)
            # The file it loads may set anything, a Supabase or Postgres target included.
            names += ['SUPABASE_FROM_DOTENV', 'PG_FROM_DOTENV']
        else:  # nohup, builtin, corepack, setsid, unbuffer
            _, _, rest = split(args, stop_first=True)
        after = self.simple(rest, cwd, depth, heredocs, names)
        # RF-061: `builtin cd dir` and `command cd dir` move the shell like `cd dir`.
        return after if name in ('command', 'builtin') else None

    def c_shell(self, name, args, cwd, depth, assigns, heredocs):
        i = 0
        inline = False
        from_stdin = False
        noexec = False
        while i < len(args):
            t = args[i].text
            if len(t) < 2 or t[0] not in '-+':
                break
            if t == '--':
                i += 1
                break
            if t.startswith('--'):
                if t in ('--rcfile', '--init-file'):
                    i += 1
            else:
                if 'c' in t[1:]:
                    inline = True
                if 's' in t[1:]:
                    from_stdin = True
                if 'n' in t[1:]:
                    noexec = t[0] == '-'  # RF-056: the last one wins, and +n switches it off again
                if t[-1] in 'oO':
                    i += 1
                    if t[-1] == 'o' and i < len(args) and args[i].text == 'noexec':
                        noexec = t[0] == '-'  # -o noexec / +o noexec
            i += 1
        rest = args[i:]
        if inline:
            if rest:
                self.line(rest[0].text, cwd, depth + 1)
            return None
        if rest and not from_stdin and rest[0].text not in STDIN_NAMES:
            if noexec and not any(a.dynamic for a in args[:i]):
                return None  # `bash -n file` parses the file and runs nothing
            if posixpath.basename(rest[0].text).lower() in MGMT_SCRIPTS:
                self.mgmt(assigns, rest[1:])
            if not rest[0].dynamic and self.under_e2e(cwd, rest[0].text):
                self.e2e(cwd, rest[0].text)
            return None
        # The shell reads its commands from standard input.
        seen = False
        for body in heredocs:
            self.line(body, cwd, depth + 1)
            seen = True
        for w in self.cmd.stdin:
            seen = True
            if posixpath.basename(w.text).lower() in MGMT_SCRIPTS:
                self.ask(MSG_MGMT)
            else:
                self.ask(MSG_STDIN_SHELL)
        if not seen and self.cmd.piped:
            self.ask(MSG_STDIN_SHELL)
        return None

    def c_eval(self, name, args, cwd, depth, assigns, heredocs):
        return self.line(' '.join(a.text for a in args), cwd, depth + 1)

    def c_source(self, name, args, cwd, depth, assigns, heredocs):
        if args and posixpath.basename(args[0].text).lower() in MGMT_SCRIPTS:
            self.ask(MSG_MGMT)
        return None

    def c_find(self, name, args, cwd, depth, assigns, heredocs):
        i = 0
        while i < len(args):
            if args[i].text in ('-exec', '-execdir', '-ok', '-okdir'):
                j = i + 1
                while j < len(args) and args[j].text not in (';', '+'):
                    j += 1
                # RF-061: -execdir / -okdir run in the directory of each match.
                inner = (False, None) if args[i].text in ('-execdir', '-okdir') else cwd
                self.simple(args[i + 1:j], inner, depth)
                i = j
            i += 1
        return None

    # rule 2
    def c_git(self, name, args, cwd, depth, assigns, heredocs):
        gopts, _, rest = split(args, 'Cc', GIT_LONG, stop_first=True)
        where = cwd
        configured = []  # refspecs given as -c remote.<name>.push=<refspec>
        for key, value in gopts:
            if key == '-C':
                where = self.chdir_word(where, value)
            elif key in ('--git-dir', '--work-tree'):
                where = (False, None)
            elif key == '-c' and value is not None:
                m = re.match(r'(?i)remote\.[^=]*\.push=(.*)$', value.text)
                if m:
                    configured.append(m.group(1))
        if not rest:
            return None
        sub = rest[0].text
        if self.git_changes_tree(sub, rest[1:]):
            self.tree_changed = True  # RF-059: for every call later in the line
        if sub in ('checkout', 'switch'):
            self.git_switch(sub, rest[1:], where)
        elif sub == 'push':
            self.git_push(rest[1:], where, configured)
        elif sub == 'subtree':
            _, pos, _ = split(rest[1:], 'Pmb', {'--prefix', '--message', '--branch', '--annotate', '--onto'})
            if pos and pos[0].text == 'push':
                for w in pos[2:]:  # pos[1] is the remote
                    forced, to_main, _ = push_refspec(w.text)
                    if forced or to_main:
                        self.deny(MSG_PUSH)
        return None

    def c_hub(self, name, args, cwd, depth, assigns, heredocs):
        """RF-063: hub is git with GitHub commands added. Its git subcommands are
        read as git's (clone, pull, checkout ... change the tree; the push rules
        apply); of its own, `hub pr checkout` and `hub sync` change the tree."""
        _, _, rest = split(args, 'Cc', GIT_LONG, stop_first=True)
        if rest:
            if rest[0].text == 'sync':
                self.tree_changed = True
            elif rest[0].text == 'pr':
                _, pos, _ = split(rest[1:])
                if pos and pos[0].text == 'checkout':
                    self.tree_changed = True
        return self.c_git(name, args, cwd, depth, assigns, heredocs)

    def git_changes_tree(self, sub, args):
        """RF-059: True when `git <sub> args` can change the working tree or
        create a checkout. `checkout -b <new>` and `switch -c <new>` only name
        the commit that is already checked out; with a start point after the
        new name they check that out, and count."""
        if sub == 'worktree':
            _, pos, _ = split(args)
            return bool(pos) and pos[0].text == 'add'
        if sub not in GIT_TREE_CHANGING:
            return False
        if sub == 'checkout':
            opts, pos, _ = split(args, 'bB', {'--orphan'})
            return not (not pos and any(key == '-b' for key, _ in opts))
        if sub == 'switch':
            opts, pos, _ = split(args, 'cC', {'--create', '--force-create', '--orphan'})
            return not (not pos and any(key in ('-c', '--create') for key, _ in opts))
        return True

    def git_switch(self, sub, args, where):
        """Remember the branch a `git checkout` / `git switch` leaves checked out."""
        if sub == 'checkout':
            opts, pos, _ = split(args, 'bB', {'--orphan'})
            creating = ('-b', '-B', '--orphan')
        else:
            opts, pos, _ = split(args, 'cC', {'--create', '--force-create', '--orphan'})
            creating = ('-c', '-C', '--create', '--force-create', '--orphan')
        for key, value in opts:
            if key in creating:
                self.switched = UNKNOWN if value is None or value.dynamic else value.text
                return
        if any(key == '--detach' for key, _ in opts):
            self.switched = ''
            return
        if sub == 'checkout' and (len(pos) != 1 or any(a.text == '--' for a in args)):
            return  # files are checked out; the branch stays
        if not pos:
            return
        target = pos[0]
        if target.dynamic or target.text == '-':
            self.switched = UNKNOWN
            return
        if sub == 'checkout' and target.text not in ('main', 'master'):
            directory = self.directory(where)
            if directory is None or os.path.lexists(os.path.join(directory, target.text)):
                return  # it may be a file, not a branch: keep what the repository says
        self.switched = target.text

    def git_push(self, args, where, configured):
        opts, pos, _ = split(args, 'o', PUSH_LONG)
        dry = False
        for key, _ in opts:
            if key in ('-n', '--dry-run'):
                dry = True
            elif key == '--no-dry-run':
                dry = False
        if dry:
            return  # nothing is sent
        for key, _ in opts:
            if key.startswith('--'):
                if key.startswith('--for') and key != '--force-if-includes':
                    self.deny(MSG_PUSH)
                elif '--all'.startswith(key) and len(key) >= 4:
                    self.deny(MSG_PUSH)
                elif len(key) >= 3 and ('--mirror'.startswith(key) or '--branches'.startswith(key)):
                    self.deny(MSG_PUSH)
            elif key == '-f':
                self.deny(MSG_PUSH)
        refspecs = [w.text for w in pos[1:]] or configured  # pos[0] is the remote
        current = not refspecs
        for spec in refspecs:
            forced, to_main, is_current = push_refspec(spec)
            if forced or to_main:
                self.deny(MSG_PUSH)
            current = current or is_current
        if not current:
            return
        # The push sends the branch that is checked out.
        branch = self.switched
        if branch is None:
            directory = self.directory(where)
            branch = UNKNOWN if directory is None else self.branch_at(directory)
        if branch is UNKNOWN:
            self.ask(MSG_PUSH_UNKNOWN)
        elif branch in ('main', 'master'):
            self.deny(MSG_PUSH)

    # rule 3
    def github_path(self, path, mutating):
        """Apply rule 3 to a GitHub REST path; True when it denied."""
        if not mutating:
            return False
        path = re.split(r'[?#]', path, 1)[0].rstrip('/').lower()
        denied = False
        if path.endswith('/merge') or path.endswith('/merges'):
            self.deny(MSG_MERGE)
            denied = True
        if '/protection' in path or re.search(r'(^|/)rulesets(/|$)', path):
            self.deny(MSG_PROTECTION)
            denied = True
        if re.search(r'(^|/)git/refs(/|$)', path):
            self.deny(MSG_REF)
            denied = True
        return denied

    def github_mutation(self, words):
        """Deny a GraphQL mutation that merges, moves a ref or changes protection; True when it denied."""
        denied = False
        for w in words:
            low = w.text.lower()
            for names, message in ((GH_MERGE_MUTATIONS, MSG_MERGE), (GH_REF_MUTATIONS, MSG_REF),
                                   (GH_PROTECTION_MUTATIONS, MSG_PROTECTION)):
                if any(mutation in low for mutation in names):
                    self.deny(message)
                    denied = True
        return denied

    def c_gh(self, name, args, cwd, depth, assigns, heredocs):
        _, _, rest = split(args, 'R', {'--repo', '--hostname'}, stop_first=True)
        if not rest:
            return None
        sub = rest[0].text
        if self.gh_changes_tree(rest):
            self.tree_changed = True  # RF-063, RF-066: for every call later in the line
        if sub == 'pr':
            _, _, after = split(rest[1:], 'R', {'--repo'}, stop_first=True)
            if after and after[0].text == 'merge':
                self.deny(MSG_MERGE)
        elif sub == 'api':
            opts, pos, _ = split(rest[1:], 'XHfFqtp', GH_API_LONG)
            method = None
            fields = False
            for key, value in opts:
                if key in ('-X', '--method'):
                    method = 'DYNAMIC' if value is None or value.dynamic else value.text.upper()
                elif key in ('-f', '-F', '--raw-field', '--field', '--input'):
                    fields = True
            mutating = method not in ('GET', 'HEAD') if method is not None else fields
            endpoint = pos[0].text if pos else ''
            if not pos or pos[0].dynamic or re.split(r'[?#]', endpoint, 1)[0].rstrip('/').lower().endswith('graphql'):
                self.github_mutation(rest[1:])
            if pos:
                self.github_path(endpoint, mutating)
        return None

    def gh_changes_tree(self, rest):
        """RF-066: True unless `gh <rest>` is known to leave the working tree
        alone. rest starts at the subcommand: the global flags and their
        values are already taken off, so a flag value that is a safe word
        (`gh -R api co 5`) is not read as the subcommand. An alias, an
        extension, an unknown word and a word held in a variable all count."""
        first = rest[0]
        if first.dynamic:
            return True
        sub = first.text
        _, _, after = split(rest[1:], 'R', {'--repo'}, stop_first=True)
        second = after[0] if after else None
        if sub in GH_SAFE_GROUPS:
            if sub in GH_DOWNLOADING:
                # `download` writes files into the tree. A second word the text
                # does not show may be it; so may any later bare `download`
                # behind a flag whose value this table does not know.
                return (second is not None and second.dynamic) or any(w.text == 'download' for w in rest[1:])
            return False
        if sub == 'issue':  # everything except exactly `develop`, which can check a branch out
            return second is not None and (second.dynamic or second.text == 'develop')
        if sub == 'pr':
            return second is None or second.dynamic or second.text not in GH_SAFE_PR
        if sub == 'repo':
            return second is None or second.dynamic or second.text not in GH_SAFE_REPO
        return True

    # rule 6
    def c_supabase(self, name, args, cwd, depth, assigns, heredocs):
        opts, pos, _ = split(args, SUPABASE_SHORT, SUPABASE_LONG)
        keys = [key for key, _ in opts]
        path = [w.text for w in pos]

        def values(key):
            return [value for k, value in opts if k == key]

        # RF-056: only --help / -h excuse a call (the CLI prints help and does
        # nothing else). `--help=false` is not help, and a short flag written
        # with `=` is not read reliably, so neither counts.
        asks_help = (any(k in ('--help', '-h') and v is None for k, v in opts)
                     and not any(re.match(r'^-[^-=]*=', w.text) for w in args))
        if any(w.dynamic for w in args):
            self.ask(MSG_SUPABASE_DYNAMIC)
            return None
        if path[:1] and path[0] in ('link', 'unlink') and not asks_help:
            self.ask(MSG_SUPABASE_LINK)  # RF-061: also when the new target is staging
            return None
        if path[:1] and path[0] in ('projects', 'orgs') and path[1:2] != ['list'] and not asks_help:
            self.ask(MSG_SUPABASE_ACCOUNT)  # create, delete, pause, restore ...: on any project
            return None
        overrides = [n for n in list(assigns) + sorted(self.env)
                     if n.upper().startswith('SUPABASE_') and n.upper() not in SUPABASE_ENV_EXEMPT]
        if overrides:
            self.ask(MSG_SUPABASE_ENV)
            return None
        if asks_help:
            return None
        if '--version' in keys and not pos:
            return None  # the bare version call: no subcommand, nothing runs
        local = any(k == '--local' and (v is None or v.text == 'true') for k, v in opts)
        # `--version` (a migration, a function version) excuses none of these.
        if path[:2] in SUPABASE_DESTRUCTIVE and not local:
            self.ask(MSG_SUPABASE_DESTRUCTIVE)
            return None
        if path[:2] == ['migration', 'down'] and not local:
            self.ask(MSG_SUPABASE_DOWN)  # RF-054
            return None
        if path[:2] == ['db', 'reset'] and not local:
            self.ask(MSG_SUPABASE_RESET)  # RF-043
            return None
        urls = values('--db-url')
        if urls:
            if not all(v is not None and self.pg_target(v) is True for v in urls):
                self.ask(MSG_SUPABASE)
            return None
        refs = values('--project-ref')
        if refs:
            named_staging = bool(self.staging) and all(
                v is not None and not v.dynamic and v.text == self.staging for v in refs)
            if not named_staging:
                self.ask(MSG_SUPABASE)
            return None
        if local:
            return None
        if path[:1] and path[0] in ('start', 'stop', 'status', 'init'):
            return None
        if path[:2] in (['migration', 'new'], ['projects', 'list'], ['orgs', 'list']):
            return None
        if path[:2] in (['db', 'lint'], ['db', 'diff']) and '--linked' not in keys:
            return None  # both work on the local database unless told otherwise
        # RF-052: the CLI uses the link of the directory it runs in (--workdir
        # replaces that directory), so the link file of the project root proves
        # staging only for a call that provably runs under that link.
        where = [self.chdir_word(cwd, v) for v in values('--workdir')] or [cwd]
        if self.staging and self.link == self.staging and all(self.linked_here(w) for w in where):
            if self.tree_changed:
                # RF-059: the link file was read before the line ran; a checkout
                # of an older commit puts the tracked production link back.
                self.ask(MSG_TREE_CHANGED)
            if self.link_touched:
                # RF-065: the link file may have been written since it was read.
                self.ask(MSG_LINK_TOUCHED)
            return None  # the linked project is provably staging
        self.ask(MSG_SUPABASE)
        return None

    # rule 7
    def host_ok(self, host):
        host = host.lower()
        return host in LOCAL_HOSTS or (bool(self.staging) and self.staging in host)

    def pg_target(self, word):
        """True: literal local or staging target. False: a target that is not. None: not a target at all."""
        t = word.text
        if '://' in t:
            rest = t.split('://', 1)[1]
            authority = re.split(r'[/?#]', rest, 1)[0]
            tail = rest[len(authority):]
            if '$' in authority or '`' in authority:
                return False
            if '%' in t or '..' in t:
                return False  # encoded or dotted text is not a provable target
            if re.search(r'[?&](host|hostaddr|service)=', tail, re.I):
                return False
            userinfo, _, hostport = authority.rpartition('@')
            hosts = [re.sub(r':\d*$', '', h).lower() for h in hostport.split(',')]
            if not hostport or not all(hosts):
                return False
            if all(h in LOCAL_HOSTS for h in hosts):
                return True
            if not self.staging:
                return False
            if all(self.staging in h for h in hosts):
                return True
            # The Supabase pooler names the project in the user: postgres.<ref>@...pooler.supabase.com
            user = userinfo.split(':', 1)[0].lower()
            return self.staging in user and all(h.endswith('.pooler.supabase.com') for h in hosts)
        if re.search(r'(^|\s)(host|hostaddr|service)\s*=', t):
            if word.dynamic or re.search(r'(^|\s)service\s*=', t):
                return False
            pairs = re.findall(r"(\w+)\s*=\s*('[^']*'|\S*)", t)
            hosts = [value.strip("'") for key, value in pairs if key in ('host', 'hostaddr')]
            return bool(hosts) and all(self.host_ok(h) for h in hosts)
        return None

    def c_pg(self, name, args, cwd, depth, assigns, heredocs):
        opts, pos, _ = split(args, PG_SHORT[name], PG_LONG)
        if any(key in PG_INFO_OPTIONS for key, _ in opts):
            return None  # prints its version or its help and exits
        targets = []
        if any(n.upper().startswith('PG') for n in list(assigns) + sorted(self.env)):
            targets.append(False)  # PGHOST, PGHOSTADDR, PGSERVICE, PGPORT ...: the target is not the literal one
        for key, value in opts:
            if key in ('-h', '--host'):
                targets.append(value is not None and not value.dynamic and self.host_ok(value.text))
            elif key in PG_DB_OPTIONS:
                if value is None or value.dynamic:
                    targets.append(False)
                else:
                    found = self.pg_target(value)
                    if found is not None:
                        targets.append(found)
        for w in pos:
            if w.dynamic:
                if name != 'pg_restore':  # its positional is an archive file, not a database
                    targets.append(False)
                continue
            found = self.pg_target(w)
            if found is not None:
                targets.append(found)
        if not (targets and all(targets)):
            self.ask(MSG_PG)
        return None

    # rule 8
    def url_parts(self, word):
        """(host, path, host is dynamic) of a URL word, with or without a scheme."""
        t = word.text
        m = re.match(r'^[A-Za-z][A-Za-z0-9+.-]*://', t)
        rest = t[m.end():] if m else t
        authority = re.split(r'[/?#]', rest, 1)[0]
        path = rest[len(authority):]
        host = re.sub(r':\d*$', '', authority.rpartition('@')[2]).lower().rstrip('.')
        return host, path, '$' in authority or '`' in authority

    def supabase_url(self, word):
        """True when a URL word addresses a Supabase host or is built from a SUPABASE variable."""
        host, _, host_dynamic = self.url_parts(word)
        if any('SUPABASE' in v.upper() for v in word.vars):
            return True
        project_host = any(host == base or host.endswith('.' + base) for base in ('supabase.co', 'supabase.in'))
        return not host_dynamic and (project_host or host == 'api.supabase.com')

    def url_asks(self, word):
        t = word.text
        host, path, host_dynamic = self.url_parts(word)
        project_host = any(host == base or host.endswith('.' + base) for base in ('supabase.co', 'supabase.in'))
        if not self.supabase_url(word):
            return False
        if self.staging and not host_dynamic and '..' not in t and '%' not in t:
            # Staging must be the project the URL addresses: a label of the host,
            # or the project segment of a management API path. Dot segments and
            # percent-encoding are resolved by the client, so they prove nothing.
            if project_host and '.' in host and self.staging in host.split('.'):
                return False
            if host == 'api.supabase.com' and re.match(
                    r'^/v1/projects/' + re.escape(self.staging) + r'(/|\?|#|$)', path):
                return False
        return True

    def github_http(self, candidates, mutating, words):
        """curl, wget or HTTPie against api.github.com: rule 3 for the known routes, ask for other changes."""
        for w in candidates:
            host, path, host_dynamic = self.url_parts(w)
            if host_dynamic or host not in ('api.github.com', 'uploads.github.com'):
                continue
            if not mutating:
                continue
            denied = self.github_path(path, True)
            if re.split(r'[?#]', path, 1)[0].rstrip('/').lower().endswith('/graphql'):
                denied = self.github_mutation(words) or denied
            if not denied:
                self.ask(MSG_GH_HTTP)

    def c_http(self, name, args, cwd, depth, assigns, heredocs):
        if name == 'curl':
            opts, pos, _ = split(args, CURL_SHORT, CURL_LONG)
        else:
            opts, pos, _ = split(args, WGET_SHORT, WGET_LONG)
        candidates = list(pos)
        method = None
        methods = []  # every method named: one curl call can make several requests (--next)
        body = False
        for key, value in opts:
            if key in (CURL_BODY if name == 'curl' else WGET_BODY):
                body = True
            if value is None:
                continue
            if key in ('-X', '--request') and name == 'curl' or key == '--method' and name == 'wget':
                method = 'DYNAMIC' if value.dynamic else value.text.upper()
                methods.append(method)
            if key == '--url':
                candidates.append(value)
            elif name == 'curl' and key in CURL_REDIRECTS:
                if 'supabase' in value.text.lower():
                    self.ask(MSG_HTTP)
        if any(self.url_asks(w) for w in candidates):
            self.ask(MSG_HTTP)
        # RF-043: DELETE on the staging project itself, or a method the text does not show.
        if any(m in ('DELETE', 'DYNAMIC') for m in methods) and any(
                self.staging_project_itself(w) for w in candidates):
            self.ask(MSG_PROJECT_DELETE)
        # RF-054: the pause endpoint of the staging project, whatever the method.
        if any(self.staging_project_pause(w) for w in candidates):
            self.ask(MSG_PROJECT_PAUSE)
        # RF-056: a config file may hold the method (-X DELETE) or another URL.
        if name == 'curl' and any(key in ('-K', '--config') for key, _ in opts) and any(
                self.supabase_url(w) for w in candidates):
            self.ask(MSG_CURL_CONFIG)
        mutating = method not in ('GET', 'HEAD') if method is not None else body
        self.github_http(candidates, mutating, args)
        return None

    def c_httpie(self, name, args, cwd, depth, assigns, heredocs):
        """HTTPie: http [METHOD] URL [item ...]."""
        _, pos, _ = split(args, HTTPIE_SHORT, HTTPIE_LONG)
        if any(self.url_asks(w) for w in pos):
            self.ask(MSG_HTTP)
        method = None
        items = pos[1:]
        if pos and re.match(r'^[A-Za-z]+$', pos[0].text) and len(pos) > 1:
            method = pos[0].text.upper()
            items = pos[2:]
        if (method == 'DELETE' or (pos and pos[0].dynamic)) and any(
                self.staging_project_itself(w) for w in pos):
            self.ask(MSG_PROJECT_DELETE)  # RF-043
        if any(self.staging_project_pause(w) for w in pos):
            self.ask(MSG_PROJECT_PAUSE)  # RF-054
        mutating = method not in ('GET', 'HEAD') if method is not None else any(
            re.search(r'[^\\]:?=', w.text) or w.dynamic for w in items)
        self.github_http(pos, mutating, args)
        return None

    # rule 9
    def c_package(self, name, args, cwd, depth, assigns, heredocs):
        # RF-053: the runner's own directory flag, wherever it stands on the
        # line, decides which package.json is used; a workspace selector picks
        # one the text does not show.
        opts, _, _ = split(args, 'CwF', {'--prefix', '--dir', '--cwd', '--filter', '--workspace'})
        for key, value in opts:
            if key in ('-C', '--prefix', '--dir', '--cwd'):
                cwd = self.chdir_word(cwd, value)
            elif key in ('-w', '-F', '--filter', '--workspace', '--workspaces', '-r', '--recursive'):
                cwd = (False, None)
        for a in args:
            if a.text == '--':
                break
            if a.text.startswith('test:'):
                self.test_script(cwd, assigns)
        _, _, rest = split(args, 'C', {'--prefix', '--dir', '--cwd', '--filter', '--workspace'}, stop_first=True)
        if not rest:
            return None
        sub = rest[0].text
        if sub in ('run', 'run-script'):
            # The script name is the first word that is not an option, also after `--`.
            for a in rest[1:]:
                if a.text.startswith('-'):
                    continue
                if a.text.startswith('test:'):
                    self.test_script(cwd, assigns)
                break
        if sub in ('exec', 'x', 'dlx'):
            self.c_npx(name, rest[1:], cwd, depth, assigns, heredocs)
        elif name != 'npm':
            # yarn, pnpm and bun also run a binary from node_modules by its name.
            self.simple(rest[1:] if sub in ('run', 'run-script') else rest, cwd, depth, (), assigns)
        return None

    def c_npx(self, name, args, cwd, depth, assigns, heredocs):
        opts, _, rest = split(args, 'pcw', {'--package', '--call', '--cache', '--registry', '--workspace',
                                             '--prefix', '--cwd', '--userconfig', '--loglevel'}, stop_first=True)
        if any(key in ('--prefix', '--cwd') for key, _ in opts):
            cwd = (False, None)  # RF-061: the tool runs for another directory
        for key, value in opts:
            if key in ('-c', '--call') and value is not None:
                self.line(value.text, cwd, depth + 1)
        if rest:
            head = Word(package_name(rest[0].text), rest[0].dynamic, rest[0].vars)
            self.simple([head] + rest[1:], cwd, depth, (), assigns)
        return None

    def c_run_all(self, name, args, cwd, depth, assigns, heredocs):
        """npm-run-all, run-s, run-p: each argument is a script name or a pattern of names."""
        for a in args:
            if a.text.startswith('-'):
                continue
            if a.text.startswith('test:') or '*' in a.text or a.dynamic:
                self.test_script(cwd, assigns)
        return None

    def c_concurrently(self, name, args, cwd, depth, assigns, heredocs):
        """concurrently "cmd one" "cmd two": each argument is a command line."""
        for a in args:
            if not a.text.startswith('-'):
                self.line(a.text, cwd, depth + 1)
        return None

    def c_node(self, name, args, cwd, depth, assigns, heredocs):
        for i, a in enumerate(args):
            if a.text.startswith('--run=test:'):
                self.test_script(cwd, assigns)
            if a.text == '--run' and i + 1 < len(args) and args[i + 1].text.startswith('test:'):
                self.test_script(cwd, assigns)
        self.c_e2e_program(name, args, cwd, depth, assigns, heredocs)
        return None

    def c_e2e_program(self, name, args, cwd, depth, assigns, heredocs):
        """A program that runs the files it is given: any argument under e2e/ asks."""
        self.e2e_args(cwd, args)
        return None

    def c_runner(self, name, args, cwd, depth, assigns, heredocs):
        """uv run x.py, poetry run python x.py, pipenv run pytest e2e ..."""
        self.c_e2e_program(name, args, cwd, depth, assigns, heredocs)
        for i, a in enumerate(args):
            if a.text != 'run':
                continue
            for j in range(i + 1, len(args)):
                w = args[j]
                if w.text == '--' or w.text.startswith('-'):
                    continue
                base = posixpath.basename(w.text).lower()
                if base in self.handlers or PYTHON_RE.match(base):
                    self.simple(args[j:], cwd, depth, heredocs, assigns)
                elif w.dynamic or '{}' in w.text:
                    self.ask(MSG_PY_DYNAMIC)
                break
            break
        return None

    def c_python(self, name, args, cwd, depth, assigns, heredocs):
        opts, _, rest = split(args, 'cmWX', stop_first=True)
        keys = [key for key, _ in opts]
        if is_info(keys) or '-V' in keys or '-h' in keys:
            return None
        if (rest and self.is_selftest(cwd, rest[0]) and not any(key in ('-c', '-m') for key in keys)
                and not any(self.names_e2e(cwd, a) for a in rest[1:])):
            return None  # the e2e self-test: no network, allowed while STAGING_REF is empty
        self.e2e_args(cwd, args)  # any argument that is a path under e2e/
        for key, value in opts:
            if key == '-c':
                return None  # inline code
            if key == '-m':
                module = value.text if value is not None else ''
                if value is not None and not value.dynamic:
                    self.e2e_module(cwd, module)  # RF-061: an e2e part anywhere in the name
                if self.under_e2e(cwd, '.'):
                    self.e2e(cwd)
                if module in ('unittest', 'pytest'):
                    for a in args:  # RF-045, RF-061: a dotted name with an e2e part
                        if not a.dynamic and not a.text.startswith('-') and '/' not in a.text:
                            self.e2e_module(cwd, a.text)
                if value is not None and value.dynamic:
                    self.ask(MSG_PY_DYNAMIC)
                if module == 'pytest':
                    self.c_pytest(name, rest, cwd, depth, assigns, heredocs)
                return None
        if not rest or rest[0].text in STDIN_NAMES:
            # The program comes from standard input. A here-document or a
            # here-string is inline code; a pipe, a file or xargs is unknown.
            if not heredocs:
                self.ask(MSG_PY_STDIN)
            return None
        script = rest[0]
        if script.dynamic or '{}' in script.text:
            self.ask(MSG_PY_DYNAMIC)
        elif self.under_e2e(cwd, script.text):
            self.e2e(cwd, script.text)
        elif not script.text.startswith(('/', '~')) and self.directory(cwd) is None:
            self.ask(MSG_PY_UNKNOWN_DIR)  # RF-061: a bare file name in a directory the text does not show
        return None

    def c_pytest(self, name, args, cwd, depth, assigns, heredocs):
        if self.under_e2e(cwd, '.'):
            self.e2e(cwd)
        self.e2e_args(cwd, args)
        return None


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def fail(message):
    """Rule 1: fail closed."""
    sys.stderr.write('guard-bash: %s; the command is blocked.\n' % message)
    sys.exit(2)


def read_conf(path):
    """KEY=value lines. A `#` at the start of a line, or after blanks following a value, starts a comment."""
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            text = handle.read()
    except (OSError, UnicodeDecodeError):
        return None
    conf = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        value = re.sub(r'(^|\s)#.*$', '', value).strip()
        conf[key.strip()] = value.strip('"\'').strip()
    return conf


def emit(decision, reasons):
    sys.stdout.write(json.dumps({'hookSpecificOutput': {
        'hookEventName': 'PreToolUse',
        'permissionDecision': decision,
        'permissionDecisionReason': ' '.join(reasons[:3]),
    }}) + '\n')


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    except (ValueError, UnicodeDecodeError, RecursionError):
        fail('the hook input on stdin is not JSON')
    tool_input = data.get('tool_input') if isinstance(data, dict) else None
    command = tool_input.get('command') if isinstance(tool_input, dict) else None
    if not isinstance(command, str) or not command.strip():
        fail('the hook input holds no command to check')

    project = os.environ.get('CLAUDE_PROJECT_DIR') or os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    conf = read_conf(os.path.join(project, 'scripts', 'hooks', 'guard.conf'))
    if conf is None or not conf.get('PROD_REF'):
        fail('scripts/hooks/guard.conf is missing or sets no PROD_REF')
    prod = conf['PROD_REF']
    staging = conf.get('STAGING_REF', '')
    for label, ref in (('PROD_REF', prod), ('STAGING_REF', staging)):
        if ref and not re.match(r'^[A-Za-z0-9_-]+$', ref):
            fail('%s in scripts/hooks/guard.conf is not a plain project ref' % label)
    if staging == prod:
        fail('STAGING_REF equals PROD_REF in scripts/hooks/guard.conf; production would count as staging')
    link = None
    try:
        with open(os.path.join(project, 'supabase', '.temp', 'project-ref'), 'r', encoding='utf-8') as handle:
            link = handle.read().strip()
    except (OSError, UnicodeDecodeError):
        pass

    if len(command) > MAX_COMMAND:
        emit('ask', [MSG_TOO_BIG])  # RF-035: not analysed at all
        return

    guard = Guard(prod, staging, link, project)
    # RF-061: a hook cwd that is missing, empty, not a string or not absolute
    # is unknown; it is not taken to be the project root.
    cwd = (False, None)
    start = data.get('cwd')
    if isinstance(start, str) and start.startswith('/'):
        cwd = guard.chdir(cwd, start)
    try:
        guard.line(command, cwd, 0)
    except TooDeep:
        guard.ask(MSG_TOO_BIG)
    except (Exception, RecursionError):  # never fail open on an analyser fault
        guard.ask(MSG_UNREADABLE)

    if guard.denies:
        emit('deny', guard.denies)
    elif guard.asks:
        emit('ask', guard.asks)


if __name__ == '__main__':
    main()
