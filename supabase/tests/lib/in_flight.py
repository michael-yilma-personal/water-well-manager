#!/usr/bin/env python3
"""Writes that are IN FLIGHT while the Drill migration runs. Test tooling only.

  in_flight.py DB MIGRATION stepwise|single
  in_flight.py DB MIGRATION stepwise|single prepare
      only creates the accounts the run will re-role, ban and unban, and
      stops. For a run on a database where those accounts must already be
      members before the migration is applied again (local.sh, "in flight,
      re-application"); the run itself then finds them there.

Decision 39 says an account created, re-roled or banned at any point of the
migration is not missed. upgrade/window_probe.sql covers writes that were
committed BETWEEN two statements. This covers the other half: a write whose
transaction is still open when a statement of the migration runs, and commits
after it. That is what the dashboard's "add user", "change role" and
"deactivate" look like to the migration when they happen at the same moment.

For every statement of the migration (stepwise), or once for the whole file
applied as one transaction (single):

  session P   opens a transaction that creates an account and re-roles an
              existing one (both write public.profiles) and leaves it open
  session B   opens a transaction that bans one existing account, and
              leaves it open
  session U   opens a transaction that unbans another, and leaves it open
              (its own transaction, so that neither of the two can be what
              makes the migration wait for the other: with a ban mirror that
              skipped ONE of its two writes while no founding organization
              exists, a single transaction doing both still held the lock;
              found in the validation of b548412)
  session M   runs the statement (or the file)

M either finishes or waits for a lock. Whenever it waits, the session it is
waiting FOR (PostgreSQL names it: pg_blocking_pids) is committed, and nothing
else; when M has finished, what is still open is committed, P first. No sleep
decides anything: the only clock is a deadline after which the run is a
failure. So the order of events is the same on every run.

Once the migration is through, every one of those accounts must have the
founding membership the legacy tables describe.

Talks only to the database named by the PG* environment (supabase/tests/
local.sh points that at its scratch cluster) through psql. Prints one line
per check, `ok<TAB>name` or `FAIL<TAB>name :: detail`, and exits 0; local.sh
counts the lines. Standard library only.
"""

import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sql_statements import split  # noqa: E402

DEADLINE_SECONDS = 60
KINDS = ("new", "role", "ban", "unban")


def lit(text):
    return "'" + text.replace("'", "''") + "'"


class Harness:
    def __init__(self, db):
        self.db = db
        self.marker = 0
        self.problems = []
        self.waited_for = {"P": 0, "B": 0, "U": 0}

    def q(self, sql):
        out = subprocess.run(
            ["psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-d", self.db, "-c", sql],
            capture_output=True, text=True)
        if out.returncode != 0:
            raise RuntimeError("control query failed: %s :: %s" % (sql[:80], out.stderr.strip()[:200]))
        return out.stdout.strip()


class Session:
    """A psql session that stays open, so a transaction can be left open in it."""

    def __init__(self, harness, name):
        self.h = harness
        self.name = "drill-fly-" + name
        env = dict(os.environ, PGAPPNAME=self.name)
        self.proc = subprocess.Popen(
            ["psql", "-X", "-q", "-At", "-d", harness.db],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, text=True, env=env)
        self.open = False
        self.pid = None

    def run(self, sql):
        """Send statements and wait until the server has finished the last of them. Returns the session's state."""
        self.h.marker += 1
        mark = "select 'fly-mark-%d';" % self.h.marker
        self.proc.stdin.write(sql.rstrip() + "\n" + mark + "\n")
        self.proc.stdin.flush()
        end = time.monotonic() + DEADLINE_SECONDS
        while True:
            row = self.h.q(
                "select pid || '|' || state from pg_stat_activity where application_name = %s and query = %s "
                "and state like 'idle%%'" % (lit(self.name), lit(mark)))
            if row:
                pid, state = row.split("|", 1)
                self.pid = pid
                return state
            if self.proc.poll() is not None:
                raise RuntimeError("session %s ended unexpectedly" % self.name)
            if time.monotonic() > end:
                raise RuntimeError("session %s did not finish: %s" % (self.name, sql[:80]))
            time.sleep(0.01)

    def begin(self, sql, label):
        state = self.run("begin;\n" + sql)
        self.open = True
        if state != "idle in transaction":
            self.h.problems.append("%s: the in-flight write itself failed (%s)" % (label, state))

    def commit(self):
        self.run("commit;")
        self.open = False

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def uid(kind, nnn):
    return "md5('drill-db-test:fly-%s:%s')::uuid" % (kind, nnn)


def email(kind, nnn):
    return "fly-%s-%s@db-test.invalid" % (kind, nnn)


def drive(h, p, b, u, nnn, m_args):
    """Open the three in-flight transactions, run M, commit what M waits for. Returns M's exit status."""
    p.begin(
        "insert into auth.users (id, email) values (%s, %s);\n" % (uid("new", nnn), lit(email("new", nnn)))
        + "update public.profiles set role = 'Supervisor', badge_number = %s where id = %s;" % (lit("F-" + nnn), uid("role", nnn)),
        "statement " + nnn + ", account creation and re-role")
    b.begin(
        "update auth.users set banned_until = now() + interval '876000 hours' where id = %s;" % uid("ban", nnn),
        "statement " + nnn + ", ban")
    u.begin(
        "update auth.users set banned_until = null where id = %s;" % uid("unban", nnn),
        "statement " + nnn + ", unban")

    env = dict(os.environ, PGAPPNAME="drill-fly-m")
    m = subprocess.Popen(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", h.db] + m_args,
                         stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=env)
    end = time.monotonic() + DEADLINE_SECONDS
    try:
        while m.poll() is None:
            blockers = h.q(
                "select coalesce(string_agg(distinct x.b::text, ','), '') from pg_stat_activity a "
                "cross join lateral unnest(pg_blocking_pids(a.pid)) as x(b) where a.application_name = 'drill-fly-m'"
            ).split(",")
            if p.open and p.pid in blockers:
                h.waited_for["P"] += 1
                p.commit()
            elif b.open and b.pid in blockers:
                h.waited_for["B"] += 1
                b.commit()
            elif u.open and u.pid in blockers:
                h.waited_for["U"] += 1
                u.commit()
            elif time.monotonic() > end:
                m.kill()
                h.problems.append("statement %s: the migration neither finished nor waited for an in-flight write" % nnn)
                break
            else:
                time.sleep(0.01)
    finally:
        if p.open:
            p.commit()
        if b.open:
            b.commit()
        if u.open:
            u.commit()
    err = m.stderr.read() if m.stderr else ""
    m.wait()
    if m.returncode != 0:
        first = next((line for line in err.splitlines() if "ERROR" in line or "FATAL" in line), err.strip()[:200])
        h.problems.append("statement %s: the migration failed: %s" % (nnn, first[:200]))
    return m.returncode


def main(argv):
    if len(argv) not in (4, 5) or argv[3] not in ("stepwise", "single") or (len(argv) == 5 and argv[4] != "prepare"):
        sys.stderr.write(__doc__)
        return 2
    db, migration, mode = argv[1], argv[2], argv[3]
    prepare_only = len(argv) == 5
    h = Harness(db)
    how = "one statement at a time" if mode == "stepwise" else "applied as one transaction"

    with open(migration, encoding="utf-8") as handle:
        statements = [text for text, _ in split(handle.read())]
    labels = ["%03d" % n for n in range(1, len(statements) + 1)] if mode == "stepwise" else ["000"]

    # The accounts that exist before the migration starts: one to re-role, one
    # to ban and one, banned, to unban, per round.
    h.q("insert into auth.users (id, email, banned_until) "
        "select md5('drill-db-test:fly-' || kind || ':' || nnn)::uuid, 'fly-' || kind || '-' || nnn || '@db-test.invalid', "
        "case when kind = 'unban' then now() + interval '876000 hours' end "
        "from unnest(array[%s]) nnn, unnest(array['role', 'ban', 'unban']) kind "
        "on conflict (id) do nothing" % ", ".join(lit(x) for x in labels))
    if prepare_only:
        print("prepared\t%d" % (3 * len(labels)))
        return 0

    p = Session(h, "p")
    b = Session(h, "b")
    u = Session(h, "u")
    applied = True
    try:
        if mode == "stepwise":
            for nnn, text in zip(labels, statements):
                if drive(h, p, b, u, nnn, ["-c", text]) != 0:
                    applied = False
                    break
        else:
            applied = drive(h, p, b, u, "000", ["-1", "-f", migration]) == 0
    except RuntimeError as err:
        h.problems.append(str(err))
        applied = False
    finally:
        p.close()
        b.close()
        u.close()

    def line(ok, name, detail=""):
        print(("ok\t" + name) if ok else ("FAIL\t" + name + " :: " + detail))

    name = "[c39] with writes in flight, drill_tenancy applies (%s)" % how
    line(applied and not h.problems, name, "; ".join(h.problems)[:400])

    expected = {
        "new":   ("'Driller/active/-'", "an account being created while %s runs ends with an active founding membership"),
        "role":  ("'Supervisor/active/F-' || n", "an account being re-roled while %s runs ends with that role and badge in its founding membership"),
        "ban":   ("'Driller/deactivated/-'", "an account being banned while %s runs ends with a deactivated founding membership"),
        "unban": ("'Driller/active/-'", "a banned account being unbanned while %s runs ends with an active founding membership"),
    }
    what = "a statement" if mode == "stepwise" else "the migration"
    for kind in KINDS:
        want, text = expected[kind]
        name = "[c39] in flight (%s): %s" % (how, text % what)
        if not applied:
            line(False, name, "not checked, the migration did not apply")
            continue
        try:
            seen = int(h.q("select count(*) from auth.users where email like 'fly-%s-%%@db-test.invalid'" % kind))
            bad = h.q(
                "select count(*) || ' of %d end otherwise (for instance ' || min(got) || '): those in flight during statement(s) ' "
                "|| string_agg(n, ', ' order by n) from ("
                "select substr(u.email, %d, 3) as n, coalesce((select string_agg(format('%%s/%%s/%%s', m.role, m.status, "
                "coalesce(m.badge_number, '-')), ' + ' order by m.org_id) from public.memberships m where m.user_id = u.id), "
                "'no membership') as got from auth.users u where u.email like 'fly-%s-%%@db-test.invalid') x "
                "where got <> %s having count(*) > 0" % (seen, len("fly-" + kind + "-") + 1, kind, want))
        except RuntimeError as err:
            line(False, name, "not checked: %s" % err)
            continue
        if seen != len(labels):
            line(False, name, "not checked, %d such account(s) for %d round(s)" % (seen, len(labels)))
        elif bad:
            line(False, name, bad)
        else:
            line(True, name + " (%d account%s)" % (seen, "" if seen == 1 else "s"))

    # The run had something to find: at least once the migration had to wait
    # for an open transaction. (CREATE TRIGGER alone guarantees that.)
    name = "[harness] in flight (%s): the migration had to wait for an open transaction at least once" % how
    line(h.waited_for["P"] + h.waited_for["B"] + h.waited_for["U"] > 0, name,
         "it never waited: the in-flight transactions did not overlap with it")
    print("# in flight (%s): the migration waited %d time(s) for the profile writes, %d time(s) for the bans and %d time(s) for the unbans"
          % (how, h.waited_for["P"], h.waited_for["B"], h.waited_for["U"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
