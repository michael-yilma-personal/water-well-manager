#!/usr/bin/env python3
"""Split a SQL file into its top-level statements. Test tooling only.

Used by the database tests for two things a line-based grep cannot do:

  sql_statements.py txn-control FILE
      Exit 1, naming each offender, when a top-level statement is transaction
      control: BEGIN, START TRANSACTION, COMMIT, END, ABORT, ROLLBACK (with or
      without WORK / TRANSACTION), PREPARE TRANSACTION, COMMIT/ROLLBACK
      PREPARED. Exit 0 when there is none. A PL/pgSQL `begin ... end;` inside
      a dollar-quoted body is not a statement and is not reported; neither is
      ROLLBACK TO SAVEPOINT, which ends nothing.

  sql_statements.py probe-script FILE PROBE
      Print a psql script that runs FILE one statement at a time and, after
      each, records which statement just ran (setting drill.stmt) and
      includes PROBE. For looking at the states a migration passes through
      when it is not applied as one transaction (Phase 1 decision 29).

Understands line and (nested) block comments, single-quoted strings (with ''
and, in E'' strings, backslash escapes), double-quoted identifiers and
dollar-quoted bodies. Standard library only; reads no network, writes no file.
"""

import re
import sys

DOLLAR_TAG = re.compile(r"\$([A-Za-z_][A-Za-z_0-9]*)?\$")

TXN_CONTROL = re.compile(
    r"""^(
        begin (\s+(work|transaction))? (\s+(isolation|read|deferrable|not)\b.*)?
      | start \s+ transaction .*
      | commit (\s+(work|transaction))? (\s+and\s+(no\s+)?chain)?
      | end (\s+(work|transaction))? (\s+and\s+(no\s+)?chain)?
      | abort (\s+(work|transaction))? (\s+and\s+(no\s+)?chain)?
      | rollback (\s+(work|transaction))? (\s+and\s+(no\s+)?chain)?
      | prepare \s+ transaction .*
      | (commit|rollback) \s+ prepared .*
    )$""",
    re.IGNORECASE | re.VERBOSE | re.DOTALL,
)


def split(sql):
    """Return [(statement_text, code_only_text)] for each top-level statement.

    statement_text is the source as written (comments included, no trailing
    semicolon); code_only_text is the same with comments removed, for
    classifying the statement.
    """
    statements = []
    raw = []
    code = []
    i = 0
    n = len(sql)

    def flush():
        text = "".join(raw).strip()
        bare = "".join(code).strip()
        if bare:
            statements.append((text, bare))
        raw.clear()
        code.clear()

    while i < n:
        ch = sql[i]
        two = sql[i:i + 2]

        if two == "--":
            j = sql.find("\n", i)
            j = n if j == -1 else j
            raw.append(sql[i:j])
            code.append(" ")
            i = j
        elif two == "/*":
            depth = 1
            j = i + 2
            while j < n and depth:
                if sql[j:j + 2] == "/*":
                    depth += 1
                    j += 2
                elif sql[j:j + 2] == "*/":
                    depth -= 1
                    j += 2
                else:
                    j += 1
            raw.append(sql[i:j])
            code.append(" ")
            i = j
        elif ch == "'":
            escapes = i > 0 and sql[i - 1] in "eE" and (i < 2 or not (sql[i - 2].isalnum() or sql[i - 2] == "_"))
            j = i + 1
            while j < n:
                if escapes and sql[j] == "\\":
                    j += 2
                elif sql[j] == "'":
                    if sql[j:j + 2] == "''":
                        j += 2
                    else:
                        j += 1
                        break
                else:
                    j += 1
            raw.append(sql[i:j])
            code.append(sql[i:j])
            i = j
        elif ch == '"':
            j = i + 1
            while j < n:
                if sql[j] == '"':
                    if sql[j:j + 2] == '""':
                        j += 2
                    else:
                        j += 1
                        break
                else:
                    j += 1
            raw.append(sql[i:j])
            code.append(sql[i:j])
            i = j
        elif ch == "$" and not (i > 0 and (sql[i - 1].isalnum() or sql[i - 1] == "_")) and DOLLAR_TAG.match(sql, i):
            tag = DOLLAR_TAG.match(sql, i).group(0)
            j = sql.find(tag, i + len(tag))
            j = n if j == -1 else j + len(tag)
            raw.append(sql[i:j])
            code.append(sql[i:j])
            i = j
        elif ch == ";":
            flush()
            i += 1
        else:
            raw.append(ch)
            code.append(ch)
            i += 1

    flush()
    return statements


def is_txn_control(code):
    return bool(TXN_CONTROL.match(" ".join(code.split())))


def summary(code, width=70):
    one_line = " ".join(code.split())
    return one_line[:width]


def cmd_txn_control(path):
    with open(path, encoding="utf-8") as handle:
        statements = split(handle.read())
    found = [summary(code) for _, code in statements if is_txn_control(code)]
    for item in found:
        print(item)
    return 1 if found else 0


def cmd_probe_script(path, probe):
    with open(path, encoding="utf-8") as handle:
        statements = split(handle.read())
    if "'" in probe or "\n" in probe:
        raise SystemExit("probe path must not contain a quote or a newline")
    for number, (text, code) in enumerate(statements, start=1):
        label = "%03d %s" % (number, re.sub(r"[^A-Za-z0-9_ .,()=-]", " ", summary(code, 60)))
        print(text + ";")
        print("select set_config('drill.stmt', '%s', false) \\gset drill_ignore_" % label)
        print("\\i '%s'" % probe)
    return 0


def main(argv):
    if len(argv) == 3 and argv[1] == "txn-control":
        return cmd_txn_control(argv[2])
    if len(argv) == 4 and argv[1] == "probe-script":
        return cmd_probe_script(argv[2], argv[3])
    sys.stderr.write(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
