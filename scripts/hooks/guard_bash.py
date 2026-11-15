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
in docs/saas/REVIEW_FINDINGS.md. A deny anywhere in the line wins over an ask;
an ask wins over allow.

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
  - a supabase CLI call that is not provably local or staging; any supabase
    call with an argument held in a variable, or with a SUPABASE_* variable
    set in front of it (directly, with env, with export earlier in the line,
    or from a dotenv file) - SUPABASE_ACCESS_TOKEN excepted, which names no
    target; the destructive calls `projects delete`, `branches delete`,
    `storage rm`, `functions delete` and `secrets unset` even on staging;
  - psql, pg_dump, pg_restore, pg_dumpall, pg_basebackup, dropdb, createdb,
    vacuumdb, reindexdb, clusterdb without a literal local or staging target,
    or with any PG* variable set in front of them;
  - curl, wget, http or https (HTTPie) to a supabase.co, supabase.in or
    api.supabase.com host, or to a URL built from a SUPABASE variable, that
    is not provably staging; a URL containing `..` or `%` is never staging;
  - any other mutating curl, wget or HTTPie request to api.github.com;
  - the management scripts, also when redirected or piped into a shell;
  - the e2e suites: a file under e2e/ that is executed, or any argument that
    names a path under e2e/ given to an interpreter or runner (python, pytest,
    uv, poetry, pipenv, coverage, tox, nox, node, deno, a shell, ...); Python
    whose script argument is a variable or `{}`; Python or a shell that reads
    its program from a pipe or a redirected file;
  - test:* package scripts with any runner, npm-run-all included;
  - a `git push` that names no branch when the directory it runs in is not
    known to the guard;
  - a command line longer than MAX_COMMAND characters or nested deeper than
    MAX_NESTING levels: it is not analysed at all.

Known limits (none of these is analysed):
  - the value of a variable: `B=main; git push origin "$B"`, `$CMD args`,
    `bash "$script"`;
  - brace and glob expansion, shell aliases, git aliases, a shell function
    defined in an earlier command of the session;
  - what a script, a package script other than test:*, a Makefile target or a
    file given to `curl -K` / `wget -i` does when it runs; what inline code
    (`python3 -c`, `node -e`, a here-document given to Python) does;
  - commands run through tools not listed as wrappers (ssh, docker, watch ...);
  - a push to main spelled through `push.default`, an upstream that differs
    from the branch name, or GIT_DIR / GIT_WORK_TREE in the environment;
  - `supabase db reset` and `supabase migration repair` are allowed on a
    provably-staging target like any other call (the existing tests pin
    this); they ask everywhere else;
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
MSG_MGMT = 'This management script talks to the production Supabase project by default.'
MSG_E2E = 'The e2e suites talk to the production Supabase project by default.'
MSG_TEST_SCRIPT = 'The test:* package scripts run suites that talk to the production Supabase project by default.'
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
    """
    __slots__ = ('words', 'subs', 'heredocs', 'keep', 'stdin', 'piped')

    def __init__(self):
        self.words = []
        self.subs = []
        self.heredocs = []
        self.keep = False
        self.stdin = []
        self.piped = False


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
        """Drop the word a redirection points at; substitutions inside it still count."""
        self.skip_blanks()
        if self.i < self.n and self.s[self.i] not in META:
            self.read_word(cmd)

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
# Deleting calls: asked even when the target is provably staging. `db reset`
# and `migration repair` are not here because the existing tests pin them as
# allowed on staging (see the header).
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
        self.denies = []
        self.asks = []
        self.cmd = Cmd()      # the simple command being analysed (its pipe and redirections)
        self.env = set()      # variables assigned or exported earlier in the line
        self.switched = None  # branch after a `git checkout` / `git switch` earlier in the line
        self.handlers = self.build_handlers()

    def deny(self, reason):
        if reason not in self.denies:
            self.denies.append(reason)

    def ask(self, reason):
        if reason not in self.asks:
            self.asks.append(reason)

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
            m = ASSIGN_RE.match(w.text) if w.bare else None
            if m:
                assigns.append(m.group(1))
                i += 1
                continue
            break
        words = words[i:]
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
            self.ask(MSG_MGMT)  # rule 9
        if '/' in text and not first.dynamic and self.under_e2e(cwd, text):
            self.ask(MSG_E2E)  # rule 9: a file under e2e/ executed directly
        elif name.endswith('.py') and self.under_e2e(cwd, text):
            self.ask(MSG_E2E)

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
        inside, path = cwd
        if target.startswith('/'):
            real = os.path.realpath(target)
            root = os.path.realpath(self.project)
            if real == root:
                return (True, '')
            if real.startswith(root + os.sep):
                return (True, real[len(root) + 1:])
            return (False, target)
        if path is None:
            return (False, None)
        joined = posixpath.normpath(posixpath.join(path, target))
        if joined == '.':
            joined = ''
        return (inside and not joined.startswith('..'), joined)

    def chdir_word(self, cwd, word):
        """The directory after `cd word` (or -C word); unknown when the word is not a literal path."""
        if word is None or word.dynamic or word.text in ('', '-') or word.text.startswith('~'):
            return (False, None)
        return self.chdir(cwd, word.text)

    def under_e2e(self, cwd, path):
        full = path if path.startswith('/') else posixpath.join(cwd[1] or '', path)
        return 'e2e' in posixpath.normpath(full).lower().split('/')

    def names_e2e(self, cwd, word):
        """True when an argument word (or the value of --option=value) is a path under e2e/."""
        if word.dynamic:
            return False
        texts = [word.text]
        if word.text.startswith('-') and '=' in word.text:
            texts.append(word.text.split('=', 1)[1])
        return any(t and self.under_e2e(cwd, t.split('::')[0]) for t in texts)

    def directory(self, cwd):
        """The absolute directory of cwd, or None when it is not known."""
        path = cwd[1]
        if path is None:
            return None
        if path.startswith('/'):
            return path
        return os.path.normpath(os.path.join(self.project, path))

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
            'cd': self.c_cd, 'pushd': self.c_cd, 'popd': self.c_popd,
            'env': self.c_env, 'eval': self.c_eval, 'source': self.c_source, '.': self.c_source,
            'export': self.c_export, 'declare': self.c_export, 'typeset': self.c_export,
            'readonly': self.c_export, 'local': self.c_export,
            'find': self.c_find,
            'git': self.c_git, 'gh': self.c_gh, 'supabase': self.c_supabase,
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
        return None

    def c_env(self, name, args, cwd, depth, assigns, heredocs):
        names = list(assigns)
        i = 0
        while i < len(args):
            t = args[i].text
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
            if t in ('-u', '--unset', '-P'):
                i += 2
                continue
            m = ASSIGN_RE.match(t)
            if m:
                names.append(m.group(1))
                i += 1
                continue
            if t.startswith('-'):
                i += 1
                continue
            break
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
            _, _, rest = split(args, 'ughpCDRTUrt', {'--user', '--group', '--host', '--prompt', '--chdir',
                                                      '--role', '--type', '--other-user', '--close-from'},
                               stop_first=True)
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
        self.simple(rest, cwd, depth, heredocs, names)
        return None

    def c_shell(self, name, args, cwd, depth, assigns, heredocs):
        i = 0
        inline = False
        from_stdin = False
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
                if t[-1] in 'oO':
                    i += 1
            i += 1
        rest = args[i:]
        if inline:
            if rest:
                self.line(rest[0].text, cwd, depth + 1)
            return None
        if rest and not from_stdin and rest[0].text not in STDIN_NAMES:
            if posixpath.basename(rest[0].text).lower() in MGMT_SCRIPTS:
                self.ask(MSG_MGMT)
            if not rest[0].dynamic and self.under_e2e(cwd, rest[0].text):
                self.ask(MSG_E2E)
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
                self.simple(args[i + 1:j], cwd, depth)
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

    # rule 6
    def c_supabase(self, name, args, cwd, depth, assigns, heredocs):
        opts, pos, _ = split(args, SUPABASE_SHORT, SUPABASE_LONG)
        keys = [key for key, _ in opts]
        path = [w.text for w in pos]

        def values(key):
            return [value for k, value in opts if k == key]

        if path[:1] and path[0] in ('projects', 'orgs') and path[1:2] != ['list']:
            self.ask(MSG_SUPABASE_ACCOUNT)
            return None
        if any(w.dynamic for w in args):
            self.ask(MSG_SUPABASE_DYNAMIC)
            return None
        overrides = [n for n in list(assigns) + sorted(self.env)
                     if n.upper().startswith('SUPABASE_') and n.upper() not in SUPABASE_ENV_EXEMPT]
        if overrides:
            self.ask(MSG_SUPABASE_ENV)
            return None
        info = is_info(keys) or '-h' in keys
        local = any(k == '--local' and (v is None or v.text == 'true') for k, v in opts)
        if path[:2] in SUPABASE_DESTRUCTIVE and not local and not info:
            self.ask(MSG_SUPABASE_DESTRUCTIVE)
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
        if '--version' in keys and not pos:
            return None
        if '--help' in keys or '-h' in keys:
            return None
        if local:
            return None
        if path[:1] and path[0] in ('start', 'stop', 'status', 'init'):
            return None
        if path[:2] in (['migration', 'new'], ['projects', 'list'], ['orgs', 'list']):
            return None
        if path[:2] in (['db', 'lint'], ['db', 'diff']) and '--linked' not in keys:
            return None  # both work on the local database unless told otherwise
        workdirs_here = all(
            v is not None and not v.dynamic and posixpath.normpath(posixpath.join(cwd[1] or '', v.text)) == '.'
            for v in values('--workdir'))
        if self.staging and self.link == self.staging and cwd[0] and workdirs_here:
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

    def url_asks(self, word):
        t = word.text
        host, path, host_dynamic = self.url_parts(word)
        from_variable = any('SUPABASE' in v.upper() for v in word.vars)
        project_host = any(host == base or host.endswith('.' + base) for base in ('supabase.co', 'supabase.in'))
        supabase_host = not host_dynamic and (project_host or host == 'api.supabase.com')
        if not (from_variable or supabase_host):
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
        body = False
        for key, value in opts:
            if key in (CURL_BODY if name == 'curl' else WGET_BODY):
                body = True
            if value is None:
                continue
            if key in ('-X', '--request') and name == 'curl' or key == '--method' and name == 'wget':
                method = 'DYNAMIC' if value.dynamic else value.text.upper()
            if key == '--url':
                candidates.append(value)
            elif name == 'curl' and key in CURL_REDIRECTS:
                if 'supabase' in value.text.lower():
                    self.ask(MSG_HTTP)
        if any(self.url_asks(w) for w in candidates):
            self.ask(MSG_HTTP)
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
        mutating = method not in ('GET', 'HEAD') if method is not None else any(
            re.search(r'[^\\]:?=', w.text) or w.dynamic for w in items)
        self.github_http(pos, mutating, args)
        return None

    # rule 9
    def c_package(self, name, args, cwd, depth, assigns, heredocs):
        for a in args:
            if a.text == '--':
                break
            if a.text.startswith('test:'):
                self.ask(MSG_TEST_SCRIPT)
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
                    self.ask(MSG_TEST_SCRIPT)
                break
        if sub in ('exec', 'x', 'dlx'):
            self.c_npx(name, rest[1:], cwd, depth, assigns, heredocs)
        elif name != 'npm':
            # yarn, pnpm and bun also run a binary from node_modules by its name.
            self.simple(rest[1:] if sub in ('run', 'run-script') else rest, cwd, depth, (), assigns)
        return None

    def c_npx(self, name, args, cwd, depth, assigns, heredocs):
        opts, _, rest = split(args, 'pcw', {'--package', '--call', '--cache', '--registry', '--workspace',
                                             '--prefix', '--userconfig', '--loglevel'}, stop_first=True)
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
                self.ask(MSG_TEST_SCRIPT)
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
                self.ask(MSG_TEST_SCRIPT)
            if a.text == '--run' and i + 1 < len(args) and args[i + 1].text.startswith('test:'):
                self.ask(MSG_TEST_SCRIPT)
        self.c_e2e_program(name, args, cwd, depth, assigns, heredocs)
        return None

    def c_e2e_program(self, name, args, cwd, depth, assigns, heredocs):
        """A program that runs the files it is given: any argument under e2e/ asks."""
        if any(self.names_e2e(cwd, a) for a in args):
            self.ask(MSG_E2E)
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
        if any(self.names_e2e(cwd, a) for a in args):
            self.ask(MSG_E2E)  # any argument that is a path under e2e/
        for key, value in opts:
            if key == '-c':
                return None  # inline code
            if key == '-m':
                module = value.text if value is not None else ''
                if module.split('.')[0].lower() == 'e2e' or self.under_e2e(cwd, '.'):
                    self.ask(MSG_E2E)
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
            self.ask(MSG_E2E)
        return None

    def c_pytest(self, name, args, cwd, depth, assigns, heredocs):
        if self.under_e2e(cwd, '.') or any(self.names_e2e(cwd, w) for w in args):
            self.ask(MSG_E2E)
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
    cwd = (True, '')
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
