#!/usr/bin/env python3
"""Bans and unbans that START while the Drill migration is running. Test tooling only.

  in_flight_started.py DB MIGRATION stepwise|single

Criterion 52 (RF-097). lib/in_flight.py opens its ban and its unban BEFORE a
statement of the migration and commits them after it. This is the other
kind: the statement is already running, its transaction open, when the ban
and the unban are issued. That is an Administrator pressing "deactivate" or
"reactivate" a moment after the operator started a statement.

How a statement is held "running", without a clock
--------------------------------------------------
The harness installs hooks in the scratch database (schema drill_fly; all of
it is removed again before the outcome is read):

  * an event trigger at ddl_command_start and one at ddl_command_end
  * a BEFORE and an AFTER statement trigger for INSERT, UPDATE and DELETE on
    every table in schema public

In the session that applies the migration, and in no other, each hook takes
and at once releases one of two advisory locks, alternately. The harness
holds both. So the migration stops at every such point INSIDE its statement,
with everything it has locked and written so far, until the harness lets it
go on to the next point. While it stands there:

  session M   is seen by the server as active, in an open transaction,
              waiting for the harness's advisory lock: the statement is in
              progress, demonstrably
  session Bn  now issues   update auth.users set banned_until = <far>  for an
              account that is not banned (autocommit, one statement)
  session Un  now issues   update auth.users set banned_until = null   for an
              account that is banned

Each of the two either finishes at once or waits for a lock the migration
holds; the harness reads which from pg_stat_activity and goes on only when
both are settled. Then it releases the one advisory lock M waits for, M runs
to its next hook (or to its end), and the same is done there with the next
pair of accounts. Nothing is decided by a sleep: every step waits for a state
the server reports, and the only clock is a deadline after which the run is a
failure. The order of events is therefore the same on every run.

How many points a statement has is counted first, by running it in a
transaction that is rolled back (the hooks count and do not stop); that many
pairs of accounts are created before the statement starts, one pair per
point. A ban that has to wait for the migration keeps its session until the
migration's transaction ends, so at most BLOCKED_ROUNDS rounds per
transaction may wait. A transaction with no more points than that (every
statement of the file, applied stepwise) gets a ban and an unban at EVERY
point. A longer one (the whole file as one transaction) gets them at every
point until FIRST_BLOCKED rounds have had to wait, and from there at evenly
spaced points up to its last, as many as there are sessions left for: the
migration gives up no lock before its transaction ends, so from the first
wait on, a ban waits wherever it starts, and cannot see what the migration
has not committed. The accounts of the points left out are banned and
unbanned once the statement is through, which changes nothing in what is
expected of them. The choice of points depends on nothing but the counts, so
it is the same on every run.

stepwise  every statement of the file, each in its own transaction
single    the file as one transaction (the control: RF-097 is not so there)

Once the migration is through:
  every account banned this way     has a deactivated founding membership
  every account unbanned this way   has an active founding membership, and
                                    can insert a borehole without org_id

Talks only to the database named by the PG* environment (supabase/tests/
local.sh points that at its scratch cluster) through psql. Prints one line
per check, `ok<TAB>name` or `FAIL<TAB>name :: detail`, and exits 0; local.sh
counts the lines. Standard library only.
"""

import os
import subprocess
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from sql_statements import split  # noqa: E402

DEADLINE_SECONDS = 120
BLOCKED_ROUNDS = 24  # two sessions each; local.sh's scratch server allows 80 connections
FIRST_BLOCKED = 3
GATE = 5252          # classid of the two advisory locks

HOOKS = r"""
create schema drill_fly;
grant usage on schema drill_fly to public;
create sequence drill_fly.hits;
grant usage on sequence drill_fly.hits to public;

create function drill_fly.gate() returns void
language plpgsql security definer set search_path = pg_catalog
as $f$
declare
  app text := current_setting('application_name', true);
  n bigint;
begin
  if app like 'drill-fly2-dry%' then
    perform nextval('drill_fly.hits');
  elsif app like 'drill-fly2-m-%' then
    n := nextval('drill_fly.hits');
    perform pg_advisory_lock_shared(5252, (n % 2)::int);
    perform pg_advisory_unlock_shared(5252, (n % 2)::int);
  end if;
end
$f$;

create function drill_fly.on_statement() returns trigger
language plpgsql as $f$ begin perform drill_fly.gate(); return null; end $f$;

create function drill_fly.on_ddl() returns event_trigger
language plpgsql as $f$ begin perform drill_fly.gate(); end $f$;

-- Rolled back with the statement under test: says whether an account can
-- insert a borehole the way an installed build does, with no org_id.
create function drill_fly.insert_refused(who uuid) returns text
language plpgsql as $f$
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    insert into public.boreholes (id, name, created_by, recorded_at) values (gen_random_uuid(), 'fly2 probe', who, now());
    raise exception using errcode = 'TR001', message = 'undo';
  exception
    when sqlstate 'TR001' then return null;
    when others then return sqlstate || ' ' || sqlerrm;
  end;
end
$f$;

do $f$
declare t regclass;
begin
  for t in select c.oid::regclass from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' loop
    execute format('create trigger drill_fly_before before insert or update or delete on %s for each statement execute function drill_fly.on_statement()', t);
    execute format('create trigger drill_fly_after after insert or update or delete on %s for each statement execute function drill_fly.on_statement()', t);
  end loop;
end
$f$;

create event trigger drill_fly_ddl_start on ddl_command_start execute function drill_fly.on_ddl();
create event trigger drill_fly_ddl_end on ddl_command_end execute function drill_fly.on_ddl();
"""

UNHOOK = r"""
drop event trigger if exists drill_fly_ddl_start;
drop event trigger if exists drill_fly_ddl_end;
do $f$
declare r record;
begin
  for r in select tgrelid::regclass as t, tgname from pg_trigger where tgname in ('drill_fly_before', 'drill_fly_after') and not tgisinternal loop
    execute format('drop trigger %I on %s', r.tgname, r.t);
  end loop;
end
$f$;
"""


def lit(text):
    return "'" + text.replace("'", "''") + "'"


class Control:
    """One psql session for the harness's own queries. It also holds the two advisory locks."""

    def __init__(self, db):
        self.db = db
        self.n = 0
        env = dict(os.environ, PGAPPNAME="drill-fly2-control")
        self.proc = subprocess.Popen(
            ["psql", "-X", "-q", "-At", "-d", db], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, env=env)

    def q(self, sql):
        self.n += 1
        end = "fly2-control-end-%d" % self.n
        self.proc.stdin.write(sql.rstrip().rstrip(";") + ";\n\\echo " + end + "\n")
        self.proc.stdin.flush()
        lines = []
        while True:
            line = self.proc.stdout.readline()
            if line == "":
                raise RuntimeError("the control session ended: %s" % sql[:80])
            line = line.rstrip("\n")
            if line == end:
                break
            lines.append(line)
        bad = [x for x in lines if "ERROR:" in x or "FATAL:" in x]
        if bad:
            raise RuntimeError("control query failed: %s :: %s" % (sql[:80], bad[0][:200]))
        return lines

    def one(self, sql):
        lines = self.q(sql)
        return lines[0] if lines else ""

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


class Writer:
    """A psql session that issues one ban or unban at a time, in autocommit."""

    count = 0

    def __init__(self, h):
        Writer.count += 1
        self.h = h
        self.name = "drill-fly2-w-%d" % Writer.count
        self.err = tempfile.NamedTemporaryFile(prefix="drill-fly2-", suffix=".err", delete=False)
        self.err_at = 0
        env = dict(os.environ, PGAPPNAME=self.name)
        self.proc = subprocess.Popen(
            ["psql", "-X", "-q", "-At", "-d", h.db], stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
            stderr=self.err, text=True, env=env)
        self.mark = None
        self.what = None

    def issue(self, sql, what):
        self.h.marker += 1
        self.mark = "select 'fly2-mark-%d'" % self.h.marker
        self.what = what
        self.proc.stdin.write(sql.rstrip().rstrip(";") + ";\n" + self.mark + ";\n")
        self.proc.stdin.flush()

    def error(self):
        """What the server said about the statements issued since the last call, if it refused one."""
        with open(self.err.name, encoding="utf-8", errors="replace") as handle:
            handle.seek(self.err_at)
            text = handle.read()
            self.err_at = handle.tell()
        return next((line.strip() for line in text.splitlines() if "ERROR" in line or "FATAL" in line), None)

    def close(self):
        try:
            self.proc.stdin.close()
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()
        try:
            self.err.close()
            os.unlink(self.err.name)
        except OSError:
            pass


class Harness:
    def __init__(self, db):
        self.db = db
        self.ctl = Control(db)
        self.marker = 0
        self.problems = []
        self.free = []          # writers with nothing running
        self.busy = []          # writers whose statement waits for the migration
        self.writers = []
        self.rounds = {}        # label -> rounds issued while the statement was in progress
        self.waited = {}        # label -> of those, rounds in which a ban or unban had to wait for it
        self.points = {}        # label -> hook points counted beforehand
        self.late = 0           # pairs of accounts acted on only after their statement
        self.uncounted = 0      # statements that stopped at more points than were counted beforehand
        self.enrolment = None   # label of the statement that enrolled the accounts that existed before

    def writer(self):
        if self.free:
            return self.free.pop()
        w = Writer(self)
        self.writers.append(w)
        return w

    def states(self, writers):
        """'done' or 'waiting' for each writer, once the server reports one of the two for all of them."""
        end = time.monotonic() + DEADLINE_SECONDS
        while True:
            rows = self.ctl.q(
                "select application_name || '|' || case when state = 'idle' then 'idle' "
                "when state = 'active' and wait_event_type = 'Lock' and cardinality(pg_blocking_pids(pid)) > 0 then 'waiting' "
                "else 'running' end || '|' || query from pg_stat_activity where application_name like 'drill-fly2-w-%'")
            seen = {}
            for row in rows:
                name, state, query = row.split("|", 2)
                seen[name] = (state, query.strip().rstrip(";"))
            out = {}
            for w in writers:
                state, query = seen.get(w.name, ("running", ""))
                if state == "idle" and query == w.mark:
                    out[w] = "done"
                elif state == "waiting":
                    out[w] = "waiting"
            if len(out) == len(writers):
                return out
            if any(w.proc.poll() is not None for w in writers):
                raise RuntimeError("a ban or unban session ended unexpectedly")
            if time.monotonic() > end:
                raise RuntimeError("a ban or unban neither finished nor waited for a lock: %s" % ", ".join(w.what for w in writers if w not in out))
            time.sleep(0.005)

    def settle(self, writers):
        """Sort writers into free and busy; report a ban or unban the server refused. Returns how many wait."""
        waiting = 0
        for w, state in self.states(writers).items():
            if state == "done":
                err = w.error()
                if err:
                    self.problems.append("%s was refused: %s" % (w.what, err[:160]))
                self.free.append(w)
            else:
                waiting += 1
                self.busy.append(w)
        return waiting

    def drain(self):
        """The migration's transaction has ended: everything that waited for it finishes now."""
        busy, self.busy = self.busy, []
        if not busy:
            return
        end = time.monotonic() + DEADLINE_SECONDS
        while True:
            states = self.states(busy)
            if all(s == "done" for s in states.values()):
                break
            if time.monotonic() > end:
                raise RuntimeError("a ban or unban still waits although the migration's transaction has ended: %s"
                                   % ", ".join(w.what for w, s in states.items() if s != "done"))
            time.sleep(0.005)
        for w in busy:
            err = w.error()
            if err:
                self.problems.append("%s was refused: %s" % (w.what, err[:160]))
            self.free.append(w)

    def m_state(self, app):
        """(in progress, gate it waits for or None) for the migration's session."""
        row = self.ctl.one(
            "select (a.state = 'active' and a.xact_start is not null and a.wait_event_type = 'Lock')::int || '|' || "
            "coalesce((select l.objid::text from pg_locks l where l.pid = a.pid and l.locktype = 'advisory' "
            "and l.classid = %d and not l.granted limit 1), '') from pg_stat_activity a where a.application_name = %s"
            % (GATE, lit(app)))
        if not row:
            return False, None
        in_progress, gate = row.split("|", 1)
        return in_progress == "1", (int(gate) if gate != "" else None)


def uid(kind, nnn, j):
    return "md5('drill-db-test:fly2-%s:%s:%03d')::uuid" % (kind, nnn, j)


def ban_sql(nnn, j):
    return "update auth.users set banned_until = now() + interval '876000 hours' where id = %s" % uid("ban", nnn, j)


def unban_sql(nnn, j):
    return "update auth.users set banned_until = null where id = %s" % uid("unban", nnn, j)


def others_enrolled(h):
    """How many memberships belong to accounts that are not this harness's own."""
    return int(h.ctl.one(
        "select count(*) from public.memberships m join auth.users u on u.id = m.user_id "
        "where u.email not like 'fly2-%@db-test.invalid'"))


def drive(h, nnn, dry_args, m_args):
    """Apply one statement (or the file) with a ban and an unban issued at every point it stops at. Returns M's exit status."""
    # 1. How many points it will stop at: run it and undo it; the hooks only count.
    before = int(h.ctl.one("select nextval('drill_fly.hits')"))
    env = dict(os.environ, PGAPPNAME="drill-fly2-dry-" + nnn)
    subprocess.run(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", h.db, "-c", "begin"] + dry_args + ["-c", "rollback"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    points = int(h.ctl.one("select nextval('drill_fly.hits')")) - before - 1
    h.points[nnn] = points
    h.rounds[nnn] = 0
    h.waited[nnn] = 0

    # 2. The accounts for it, committed before it starts: one to ban and one, banned, to unban, per point.
    if points > 0:
        h.ctl.q(
            "insert into auth.users (id, email, banned_until) "
            "select md5('drill-db-test:fly2-' || kind || ':%s:' || to_char(j, 'FM000'))::uuid, "
            "'fly2-' || kind || '-%s-' || to_char(j, 'FM000') || '@db-test.invalid', "
            "case when kind = 'unban' then now() + interval '876000 hours' end "
            "from generate_series(1, %d) j, unnest(array['ban', 'unban']) kind" % (nnn, nnn, points))
    enrolled_before = others_enrolled(h)

    # 3. Both gates shut, then the statement.
    h.ctl.q("select pg_advisory_unlock_all()")
    h.ctl.q("select pg_advisory_lock(%d, 0), pg_advisory_lock(%d, 1)" % (GATE, GATE))
    app = "drill-fly2-m-" + nnn
    env = dict(os.environ, PGAPPNAME=app)
    m = subprocess.Popen(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", h.db] + m_args,
                         stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=env)
    end = time.monotonic() + DEADLINE_SECONDS
    point = 0            # the point M stands at, counted from 1
    used = set()         # the points a ban and an unban were issued at
    stride = 1           # from the FIRST_BLOCKED-th wait on: every stride-th point
    stride_from = None
    free_run = False
    try:
        while m.poll() is None:
            in_progress, gate = (False, None) if free_run else h.m_state(app)
            if gate is not None:
                point += 1
                if point > points:
                    # More points than were counted: no account is left for them. Let it run to its end.
                    h.uncounted += 1
                    free_run = True
                    h.ctl.q("select pg_advisory_unlock_all()")
                    continue
                wanted = stride_from is None or (point - stride_from) % stride == 0
                if wanted and h.waited[nnn] < BLOCKED_ROUNDS:
                    used.add(point)
                    if not in_progress:
                        h.problems.append("statement %s, point %d: the migration stood at the gate but was not reported active in an open transaction" % (nnn, point))
                    b = h.writer()
                    u = h.writer()
                    b.issue(ban_sql(nnn, point), "the ban issued during statement %s (point %d)" % (nnn, point))
                    u.issue(unban_sql(nnn, point), "the unban issued during statement %s (point %d)" % (nnn, point))
                    waiting = h.settle([b, u])
                    # Still there: both were issued, and settled, while the statement stood still.
                    still, gate_now = h.m_state(app)
                    if still and gate_now == gate:
                        h.rounds[nnn] += 1
                        if waiting:
                            h.waited[nnn] += 1
                            if h.waited[nnn] == FIRST_BLOCKED:
                                left = BLOCKED_ROUNDS - FIRST_BLOCKED
                                stride = max(1, -(-(points - point) // left))
                                # Counted back from the last point, so that the last point is one of them.
                                stride_from = points
                    else:
                        h.problems.append("statement %s, point %d: the migration moved while the ban and the unban were being issued" % (nnn, point))
                # On to the next point: open this gate, wait until M stands at the other (or is through), shut it again.
                h.ctl.q("select pg_advisory_unlock(%d, %d)" % (GATE, gate))
                while m.poll() is None:
                    _, at = h.m_state(app)
                    if at is not None and at != gate:
                        break
                    if time.monotonic() > end:
                        break
                    time.sleep(0.005)
                if m.poll() is None and time.monotonic() <= end:
                    h.ctl.q("select pg_advisory_lock(%d, %d)" % (GATE, gate))
            elif time.monotonic() > end:
                m.kill()
                h.problems.append("statement %s: the migration neither finished nor reached a gate in %d seconds" % (nnn, DEADLINE_SECONDS))
                break
            else:
                time.sleep(0.005)
    finally:
        h.ctl.q("select pg_advisory_unlock_all()")
    err = m.stderr.read() if m.stderr else ""
    m.wait()
    if m.returncode != 0:
        first = next((line for line in err.splitlines() if "ERROR" in line or "FATAL" in line), err.strip()[:200])
        h.problems.append("statement %s: the migration failed: %s" % (nnn, first[:200]))

    # 4. Its transaction has ended: what waited for it finishes. Then the accounts no point was left for.
    h.drain()
    for j in range(1, points + 1):
        if j in used:
            continue
        h.late += 1
        b = h.writer()
        u = h.writer()
        b.issue(ban_sql(nnn, j), "the ban issued after statement %s" % nnn)
        u.issue(unban_sql(nnn, j), "the unban issued after statement %s" % nnn)
        h.settle([b, u])
        h.drain()

    if m.returncode == 0 and h.enrolment is None and enrolled_before == 0 and others_enrolled(h) > 0:
        h.enrolment = nnn
    return m.returncode


def main(argv):
    if len(argv) != 4 or argv[3] not in ("stepwise", "single"):
        sys.stderr.write(__doc__)
        return 2
    db, migration, mode = argv[1], argv[2], argv[3]
    how = "one statement at a time" if mode == "stepwise" else "applied as one transaction"
    what = "a statement" if mode == "stepwise" else "the migration"

    with open(migration, encoding="utf-8") as handle:
        statements = [text for text, _ in split(handle.read())]

    h = Harness(db)
    applied = True
    unhooked = False
    try:
        subprocess.run(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-1", "-d", db, "-c", HOOKS],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        if mode == "stepwise":
            for n, text in enumerate(statements, 1):
                if drive(h, "%03d" % n, ["-c", text], ["-c", text]) != 0:
                    applied = False
                    break
        else:
            applied = drive(h, "000", ["-f", migration], ["-1", "-f", migration]) == 0
    except subprocess.CalledProcessError as err:
        h.problems.append("the harness's hooks could not be installed: %s" % (err.stderr or "").strip()[:200])
        applied = False
    except RuntimeError as err:
        h.problems.append(str(err))
        applied = False
    finally:
        for w in h.writers:
            w.close()
        try:
            h.ctl.q("select pg_advisory_unlock_all()")
            subprocess.run(["psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-1", "-d", db, "-c", UNHOOK],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            unhooked = True
        except Exception:
            pass

    def line(ok, name, detail=""):
        print(("ok\t" + name) if ok else ("FAIL\t" + name + " :: " + detail))

    def q(sql):
        return h.ctl.one(sql)

    if not unhooked:
        h.problems.append("the harness's hooks could not be removed")
    name = "[c52] with bans and unbans starting while %s is running, drill_tenancy applies and no ban or unban is refused (%s)" % (what, how)
    line(applied and not h.problems, name, "; ".join(h.problems)[:400])

    rounds = sum(h.rounds.values())
    expected = (
        ("ban", "'Driller/deactivated/-'",
         "an account banned while %s is already running ends with a deactivated founding membership"),
        ("unban", "'Driller/active/-'",
         "a banned account unbanned while %s is already running ends with an active founding membership"),
    )
    for kind, want, text in expected:
        name = "[c52] started in flight (%s): %s" % (how, text % what)
        if not applied:
            line(False, name, "not checked, the migration did not apply")
            continue
        try:
            seen = int(q("select count(*) from auth.users where email like 'fly2-%s-%%@db-test.invalid'" % kind))
            bad = q(
                "select count(*) || ' of %d end otherwise (for instance ' || min(got) || '): those of statement(s) ' "
                "|| string_agg(distinct n, ', ' order by n) from ("
                "select substr(u.email, %d, 3) as n, coalesce((select string_agg(format('%%s/%%s/%%s', m.role, m.status, "
                "coalesce(m.badge_number, '-')), ' + ' order by m.org_id) from public.memberships m where m.user_id = u.id), "
                "'no membership') as got from auth.users u where u.email like 'fly2-%s-%%@db-test.invalid') x "
                "where got <> %s having count(*) > 0" % (seen, len("fly2-" + kind + "-") + 1, kind, want))
        except RuntimeError as err:
            line(False, name, "not checked: %s" % err)
            continue
        if seen == 0 or rounds == 0:
            line(False, name, "not checked, no ban or unban was issued while %s was running" % what)
        elif bad:
            line(False, name, bad)
        else:
            line(True, name + " (%d account%s)" % (seen, "" if seen == 1 else "s"))

    name = "[c52] started in flight (%s): ... and each of those unbanned accounts can then insert a borehole without org_id" % how
    if not applied:
        line(False, name, "not checked, the migration did not apply")
    else:
        try:
            seen = int(q("select count(*) from auth.users where email like 'fly2-unban-%@db-test.invalid'"))
            bad = q(
                "select count(*) || ' of %d are refused (for instance: ' || min(why) || '): those of statement(s) ' "
                "|| string_agg(distinct n, ', ' order by n) from ("
                "select substr(u.email, %d, 3) as n, drill_fly.insert_refused(u.id) as why from auth.users u "
                "where u.email like 'fly2-unban-%%@db-test.invalid') x where why is not null having count(*) > 0"
                % (seen, len("fly2-unban-") + 1))
            if seen == 0 or rounds == 0:
                line(False, name, "not checked, no unban was issued while %s was running" % what)
            elif bad:
                line(False, name, bad[:400])
            else:
                line(True, name + " (%d account%s)" % (seen, "" if seen == 1 else "s"))
        except RuntimeError as err:
            line(False, name, "not checked: %s" % err)

    # The run had something to find.
    if mode == "stepwise":
        name = ("[harness] started in flight (%s): the statement that enrols the accounts that existed before was running, "
                "its transaction open, when a ban and an unban were issued" % how)
        if h.enrolment is None:
            line(False, name, "no statement was seen to enrol them")
        elif h.rounds.get(h.enrolment, 0) == 0:
            line(False, name, "statement %s enrolled them, and it never stood at a gate with an account left to act on" % h.enrolment)
        else:
            line(True, name)
    else:
        name = ("[harness] started in flight (%s): the migration was running, its transaction open, "
                "when a ban and an unban were issued" % how)
        line(rounds > 0, name, "it never stood at a gate")

    with_points = sum(1 for n in h.points.values() if n > 0)
    with_rounds = sum(1 for n in h.rounds.values() if n > 0)
    print("# started in flight (%s): %d statement(s), %d with a point to stop at, %d stopped; %d pair(s) of ban and unban "
          "issued while a statement was running, %d of them had to wait for it; %d pair(s) issued only after their statement; %d statement(s) had more points than were counted%s"
          % (how, len(h.points), with_points, with_rounds, rounds, sum(h.waited.values()), h.late, h.uncounted,
             "; the enrolment is statement %s (%d pair(s) issued during it, %d waited)"
             % (h.enrolment, h.rounds.get(h.enrolment, 0), h.waited.get(h.enrolment, 0)) if h.enrolment else ""))

    try:
        subprocess.run(["psql", "-X", "-q", "-d", db, "-c", "drop schema if exists drill_fly cascade"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    finally:
        h.ctl.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
