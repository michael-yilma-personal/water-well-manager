#!/usr/bin/env python3
"""The last-administrator rule under concurrency. Test tooling only.

  members_concurrency.py

SaaS Phase 2, task P2-1, criterion 4: two requests that each remove,
deactivate or demote a DIFFERENT one of an organization's two active
administrators cannot both succeed.

A check inside one transaction cannot show this: each request, looking at the
database on its own, sees the other administrator still in place. So this
uses two real sessions, as lib/in_flight.py does, for each of the nine ordered
pairs of {remove, deactivate, demote}:

  fixture     an organization with exactly two active Administrators, A and
              B, and nobody else (committed: the two sessions must see it)
  session 1   opens a transaction, calls the function that takes B out of the
              administrators (asked by A), and leaves the transaction OPEN
  session 2   in its own transaction calls the function that takes A out
              (asked by B), and commits

Session 2 either finishes or waits for a lock. When it waits for session 1
(PostgreSQL names the session it waits for: pg_blocking_pids), session 1 is
committed; when it finishes without waiting, session 1 is committed after it.
No sleep decides anything: the only clock is a deadline after which the case
is a failure. So the order of events is the same on every run.

The case passes when exactly one of the two requests succeeded, the other was
refused by the function (not by an error that says the call itself is broken:
before the migration exists every call fails, and that is not a refusal), and
the organization still has one active Administrator.

Before the nine cases the tool is tried on two writes that nothing guards
(two plain UPDATEs, each deactivating one of two Drillers): it must see both
succeed and neither left active, or its verdicts mean nothing.

SaaS Phase 3, task P3-1, criterion 3, with the same tool: an organization
with two members and a limit of three users, and two plain INSERTs that each
add a different person. One must be refused with the user-limit SQLSTATE
(SEAT_STATE: the tests' assumption, see sql/56_subscriptions.sql).

Everything it creates is committed, so everything is deleted again whatever
happens, and the last line says whether the database is as it was. Accounts
are *@db-test.invalid; the organizations are named "Concurrency test N".

Talks only to the database named by the PG* environment (run.sh has already
refused any host that is not this machine) through psql. Prints one line per
check, `ok<TAB>name` or `FAIL<TAB>name :: detail`, thirteen in all, and exits 0;
run.sh counts the lines. Standard library only.
"""

import hashlib
import os
import re
import subprocess
import sys
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from in_flight import Harness, Session, lit  # noqa: E402

DEADLINE_SECONDS = 60
OPS = ("remove", "deactivate", "demote")
LINES = 13
SEAT_STATE = "SS001"

# An error that says the call is broken, not that the function refused.
BROKEN_STATES = {"42883", "42P01", "42703", "42601", "42804", "42725", "42846", "42P02", "3F000"}


def uid(label):
    return str(uuid.UUID(hashlib.md5(("drill-db-test:" + label).encode()).hexdigest()))


def call(op, org, member, actor):
    if op == "remove":
        return "select public.saas_remove_member(%s, %s, %s);" % (lit(org), lit(member), lit(actor))
    if op == "deactivate":
        return "select public.saas_set_member_status(%s, %s, 'deactivated', %s);" % (lit(org), lit(member), lit(actor))
    if op == "demote":
        return "select public.saas_set_member_role(%s, %s, 'Driller', %s);" % (lit(org), lit(member), lit(actor))
    raise ValueError(op)


def unguarded(org, member):
    return "update public.memberships set status = 'deactivated' where org_id = %s and user_id = %s;" % (lit(org), lit(member))


def first_error(text):
    """(sqlstate, message) of the first error psql reported with VERBOSITY=verbose."""
    for line in text.splitlines():
        m = re.search(r"(?:ERROR|FATAL):\s+([0-9A-Z]{5}):\s+(.*)$", line)
        if m:
            return m.group(1), m.group(2).strip()
    return None, text.strip()[:200]


def broken(state, msg):
    return state is None or state in BROKEN_STATES or re.match(r"permission denied for (function|table|schema|sequence|relation)", msg or "") is not None


def psql_once(db, sql):
    """Run sql in one psql that stops at the first error. Returns (ok, sqlstate, message)."""
    out = subprocess.run(
        ["psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-d", db, "-c", sql],
        capture_output=True, text=True)
    if out.returncode == 0:
        return True, None, None
    state, msg = first_error(out.stderr)
    return False, state, msg


def fixture(h, n, role="Administrator"):
    """An organization with two active members of that role and nobody else. Returns (org, a, b)."""
    org, a, b = uid("conc-org-%d" % n), uid("conc-%d-a" % n), uid("conc-%d-b" % n)
    h.q(
        "begin;"
        "insert into public.organizations (id, name) values (%s, %s);" % (lit(org), lit("Concurrency test %d" % n))
        + "insert into auth.users (id, email) values (%s, %s), (%s, %s);" % (
            lit(a), lit("conc-%d-a@db-test.invalid" % n), lit(b), lit("conc-%d-b@db-test.invalid" % n))
        # Whatever the accounts were given on creation is replaced by exactly this.
        + "delete from public.memberships where user_id in (%s, %s);" % (lit(a), lit(b))
        + "insert into public.memberships (org_id, user_id, role, status) values (%s, %s, %s, 'active'), (%s, %s, %s, 'active');" % (
            lit(org), lit(a), lit(role), lit(org), lit(b), lit(role))
        + "commit;")
    got = h.q("select count(*) from public.memberships where org_id = %s and role = %s and status = 'active'" % (lit(org), lit(role)))
    if got != "2":
        raise RuntimeError("the fixture of case %d is not two active members with the role %s (%s)" % (n, role, got))
    return org, a, b


def cleanup(h):
    h.q(
        "begin;"
        "do $$ begin if to_regclass('public.subscriptions') is not null then"
        " delete from public.subscriptions where org_id in (select id from public.organizations where name like 'Concurrency test %');"
        " end if; end $$;"
        "delete from public.audit_log where org_id in (select id from public.organizations where name like 'Concurrency test %');"
        "delete from public.memberships where org_id in (select id from public.organizations where name like 'Concurrency test %')"
        "   or user_id in (select id from auth.users where email ~ '^conc-[0-9]+-[ab]@db-test[.]invalid$');"
        "delete from public.audit_log where actor_id in (select id from auth.users where email ~ '^conc-[0-9]+-[ab]@db-test[.]invalid$');"
        "delete from auth.users where email ~ '^conc-[0-9]+-[ab]@db-test[.]invalid$';"
        "delete from public.organizations where name like 'Concurrency test %';"
        "commit;")


def left_behind(h):
    return h.q(
        "select (select count(*) from public.organizations where name like 'Concurrency test %%')"
        " || ' organization(s), ' || (select count(*) from auth.users where email ~ '^conc-[0-9]+-[ab]@db-test[.]invalid$')"
        " || ' account(s), ' || (select count(*) from public.profiles where id in (%s))"
        " || ' profile(s)'" % ", ".join(lit(uid("conc-%d-%s" % (n, x))) for n in range(0, 12) for x in "ab"))


def race(h, n, sql1, sql2, as_service, role="Administrator"):
    """Run sql1 in a transaction left open, sql2 in a second session; commit the first when the second waits for it.

    Returns a dict: ok1, ok2 (did each request succeed and commit), err1, err2 ((sqlstate, message) or None),
    waited (did session 2 wait for session 1), admins (active members with `role` left), problem (text or None).
    """
    org = uid("conc-org-%d" % n)
    become = "set local role service_role;\n" if as_service else ""
    res = {"ok1": False, "ok2": False, "err1": None, "err2": None, "waited": False, "admins": None, "problem": None}

    s1 = Session(h, "members-1-%d" % n)
    m = None
    try:
        state = s1.run("begin;\n" + become + sql1)
        s1.open = True
        if state != "idle in transaction":
            # The first request itself failed. Say why: the same call, on its own, undone.
            s1.run("rollback;")
            s1.open = False
            _, st, msg = psql_once(h.db, "begin; " + become.strip() + " " + sql1 + " rollback;")
            res["err1"] = (st, msg)

        env = dict(os.environ, PGAPPNAME="drill-fly-members-2")
        m = subprocess.Popen(
            ["psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-d", h.db,
             "-c", "begin; " + become.strip() + " " + sql2 + " commit;"],
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, env=env)
        end = time.monotonic() + DEADLINE_SECONDS
        while m.poll() is None:
            blockers = h.q(
                "select coalesce(string_agg(distinct x.b::text, ','), '') from pg_stat_activity a "
                "cross join lateral unnest(pg_blocking_pids(a.pid)) as x(b) where a.application_name = 'drill-fly-members-2'"
            ).split(",")
            if s1.open and s1.pid in blockers:
                res["waited"] = True
                state = s1.run("commit;")
                s1.open = False
                res["ok1"] = True
            elif time.monotonic() > end:
                m.kill()
                res["problem"] = "the second request neither finished nor waited for the first"
                break
            else:
                time.sleep(0.01)
        err = m.stderr.read() if m.stderr else ""
        m.wait()
        if m.returncode == 0:
            res["ok2"] = True
        else:
            res["err2"] = first_error(err)
        if s1.open:
            # The second request finished without waiting. The first commits now.
            s1.run("commit;")
            s1.open = False
            # A commit that failed leaves the membership as it was; the count below shows it.
            res["ok1"] = True
    finally:
        if m is not None and m.poll() is None:
            m.kill()
        if s1.open:
            try:
                s1.run("rollback;")
            except Exception:
                pass
        s1.close()
    res["admins"] = h.q(
        "select count(*) from public.memberships where org_id = %s and role = %s and status = 'active'" % (lit(org), lit(role)))
    return res


def describe(res):
    def one(ok, err):
        if ok:
            return "succeeded"
        if err is None:
            return "failed"
        return "failed with %s: %s" % (err[0], (err[1] or "")[:110])
    return "first request %s; second request %s%s; still active: %s" % (
        one(res["ok1"], res["err1"]), one(res["ok2"], res["err2"]),
        " (it waited for the first)" if res["waited"] else " (it did not wait for the first)", res["admins"])


def main():
    out = []

    def line(ok, name, detail=""):
        out.append("%s\t%s%s" % ("ok" if ok else "FAIL", name, "" if ok or not detail else " :: " + detail))

    db = os.environ.get("PGDATABASE") or ""
    if not db:
        db = subprocess.run(["psql", "-X", "-q", "-At", "-c", "select current_database()"],
                            capture_output=True, text=True).stdout.strip()
    h = Harness(db)

    names = ["[harness] concurrency: two writes that nothing guards are seen for what they are: both succeed, neither member is left active"]
    for first in OPS:
        for second in OPS:
            names.append(
                "[P2-1 c4] two requests at the same moment, one to %s one of an organization's two active Administrators, "
                "the other to %s the other one: they cannot both succeed" % (first, second))
    names.append("[harness] concurrency: lib/members_concurrency.py ran to its end")
    names.append("[P2-1 c4] ... and afterwards the database is as it was: the test's organizations and accounts are gone")

    done = 0
    crashed = None
    try:
        cleanup(h)   # of an earlier run that was killed

        # Two Drillers, so that no rule about administrators, however it is
        # enforced, has anything to say about these two writes.
        org, a, b = fixture(h, 0, role="Driller")
        res = race(h, 0, unguarded(org, b), unguarded(org, a), as_service=False, role="Driller")
        line(res["ok1"] and res["ok2"] and res["admins"] == "0" and res["problem"] is None, names[0], describe(res))
        done = 1

        n = 0
        for first in OPS:
            for second in OPS:
                n += 1
                org, a, b = fixture(h, n)
                res = race(h, n, call(first, org, b, a), call(second, org, a, b), as_service=True)
                lost = res["err2"] if res["ok1"] else res["err1"]
                good = (res["problem"] is None
                        and res["ok1"] != res["ok2"]
                        and lost is not None and not broken(lost[0], lost[1])
                        and res["admins"] == "1")
                detail = res["problem"] or describe(res)
                if res["problem"] is None and res["ok1"] != res["ok2"] and lost is not None and broken(lost[0], lost[1]):
                    detail = "the request that failed was not refused by the function, the call itself is broken; " + detail
                line(good, names[n], detail)
                done = n + 1
    except Exception as exc:   # the tool itself; every check not reached is a failure
        crashed = str(exc)[:240]
    for name in names[done:10]:
        line(False, name, "not checked, the tool stopped: " + (crashed or "?"))

    # P3-1 criterion 3: the last free seat. Two members, a limit of three,
    # and two people (the members of a second organization) added at once.
    seat = ("[P3-1 c3] two inserts at the same moment, each adding a different person to an organization "
            "with one free seat: they cannot both succeed, and the loser gets %s" % SEAT_STATE)
    try:
        org, a, b = fixture(h, 10, role="Driller")
        _, c, d = fixture(h, 11, role="Driller")
        h.q("insert into public.subscriptions (org_id, plan_id, status, max_users_override) values (%s, 'standard', 'active', 3) "
            "on conflict (org_id) do update set plan_id = 'standard', status = 'active', ends_at = null, max_users_override = 3" % lit(org))
        add = "insert into public.memberships (org_id, user_id, role, status) values (%s, %s, 'Driller', 'active');"
        res = race(h, 10, add % (lit(org), lit(c)), add % (lit(org), lit(d)), as_service=False, role="Driller")
        lost = res["err2"] if res["ok1"] else res["err1"]
        line(res["problem"] is None and res["ok1"] != res["ok2"] and lost is not None and lost[0] == SEAT_STATE
             and res["admins"] == "3", seat, res["problem"] or describe(res))
    except Exception as exc:
        line(False, seat, "not checked: " + str(exc)[:240])

    line(crashed is None, names[10], crashed or "")

    try:
        cleanup(h)
        left = left_behind(h)
        line(left == "0 organization(s), 0 account(s), 0 profile(s)", names[11], "left behind: " + left)
    except Exception as exc:
        line(False, names[11], "the cleanup failed: " + str(exc)[:240])

    assert len(out) == LINES
    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
