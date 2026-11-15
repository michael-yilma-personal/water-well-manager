#!/usr/bin/env node
// Static check: every table created in the public schema by supabase/migrations
// has row level security enabled.
//
// Why: the Supabase publishable key ships inside the APK and the web bundle, so
// anyone can call the API with it. Row level security is the only barrier
// between that key and the data. A public table without it is readable and
// writable by the world, and nothing else in the build would notice.
//
// Usage:  node scripts/check-migrations.mjs [dir]     (default supabase/migrations)
//   exit 0  every public table has RLS enabled
//   exit 1  one line per table that does not
//   exit 2  the directory is missing, not a directory, has no .sql files, or
//           one of its .sql files cannot be read (so a wrong path or a broken
//           file can never look like a pass, nor like a finding)
//
// What it recognises, in any letter case and across line breaks:
//   create table [if not exists] [public.]name (...)
//   alter table [if exists] [only] [public.]name enable row level security
//   alter table [if exists] [only] [public.]name disable row level security
//   alter table [if exists] [only] [public.]name rename to new_name
//   drop table [if exists] [public.]name [, [public.]name ...]
//   foreach t in array array['a', 'b'] loop
//     execute format('alter table public.%I enable row level security', t);
//   end loop                                  -- counts for every table listed
//
// Statements are applied in order, file by file: the last enable or disable
// wins; a drop forgets the table and its RLS, so a table dropped and re-created
// must enable RLS again; a rename moves the table and its RLS to the new name,
// so a new table created under the old name starts unprotected.
//
// Comments (-- to end of line, and /* ... */, which nests as in Postgres) are
// removed first. A '--' or '/*' inside a single-quoted string ('' escapes a
// quote) or a double-quoted identifier is not a comment start. Dollar-quoted
// bodies (do $$ ... $$, function bodies) are read as SQL, so the statements,
// strings and comments inside them are treated like any others.
//
// Known limits. This is a guard built on regular expressions, not a SQL parser:
//   - Enabling RLS before the create (alter table if exists ... enable, then
//     create table) counts, though in Postgres it is a no-op.
//   - It does not look at whether any policy exists; it only checks that RLS
//     is enabled.
//   - String contents are not hidden from the statement patterns: SQL text
//     inside a string literal (other than the foreach form above) is read as if
//     it were a statement.
//   - Backslash escapes (E'it\'s') are not understood, and a dollar-quoted
//     body used as plain text with an odd number of quotes ($$it's$$) is read
//     as SQL; either can shift where strings start and end for the rest of the
//     file, and with that which '--' and '/*' count as comments.
//   - Tables created by dynamic SQL (execute format('create table ...')),
//     create table ... inside a function body that is never called, and tables
//     created outside the migrations directory are not understood.
//   - "enable row level security" must be the first action of its alter table.
//     This errs towards reporting a table, never towards hiding one. The same
//     holds for "disable" and "rename to", where it errs the other way.
//   - The dynamic form must be the exact foreach/array-literal/format shape
//     above, with no nested loop inside it.
//   - A table with no schema prefix is assumed to be in public (search_path is
//     not tracked).

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const IDENT = String.raw`"[^"]+"|[a-z_][\w$]*`;
// [schema.]name, not followed by more identifier or another dot, so the match
// cannot stop half way through a name or mistake a schema for a table.
const QNAME = String.raw`(?:(${IDENT})\s*\.\s*)?(${IDENT})(?![\w$"]|\s*\.)`;
// The same without capture groups, for lists of names.
const QNAME_NC = String.raw`(?:(?:${IDENT})\s*\.\s*)?(?:${IDENT})(?![\w$"]|\s*\.)`;
const RLS = String.raw`\s+row\s+level\s+security\b`;
const ENABLE = String.raw`\s+enable${RLS}`;
const ALTER = String.raw`alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?`;

/**
 * The SQL with every comment replaced by a space. Single-quoted strings and
 * double-quoted identifiers are copied through untouched (a doubled quote is an
 * escaped quote), so a "--" or "/*" inside one never starts a comment. Block
 * comments nest; one that is never closed runs to the end of the file.
 */
function stripComments(sql) {
  const end = sql.length;
  let out = '';
  let i = 0;
  while (i < end) {
    const char = sql[i];
    const next = sql[i + 1];
    if (char === "'" || char === '"') {
      let j = i + 1;
      while (j < end) {
        if (sql[j] !== char) j += 1;
        else if (sql[j + 1] === char) j += 2;
        else break;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (char === '-' && next === '-') {
      while (i < end && sql[i] !== '\n') i += 1;
      out += ' ';
    } else if (char === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < end && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else i += 1;
      }
      out += ' ';
    } else {
      out += char;
      i += 1;
    }
  }
  return out;
}

const STATEMENTS = {
  // The lookahead keeps "create table if not exists" (no name) from naming "if".
  create: new RegExp(
    String.raw`\bcreate\s+(?:unlogged\s+)?table\s+(?:if\s+not\s+exists\s+)?${QNAME}(?=\s*(?:\(|as\b|of\b|partition\b))`,
    'gi',
  ),
  enable: new RegExp(String.raw`\b${ALTER}${QNAME}${ENABLE}`, 'gi'),
  disable: new RegExp(String.raw`\b${ALTER}${QNAME}\s+disable${RLS}`, 'gi'),
  // "rename column a to b" and "rename constraint a to b" do not match.
  rename: new RegExp(String.raw`\b${ALTER}${QNAME}\s+rename\s+to\s+(${IDENT})`, 'gi'),
};

// One group: the whole comma-separated list of names.
const DROP = new RegExp(
  String.raw`\bdrop\s+table\s+(?:if\s+exists\s+)?(${QNAME_NC}(?:\s*,\s*${QNAME_NC})*)`,
  'gi',
);
const NAME_IN_LIST = new RegExp(QNAME, 'gi');

const isPublic = (schema) => schema === undefined || bare(schema) === 'public';

const FOREACH_LOOP =
  /\bforeach\s+(\w+)\s+in\s+array\s+array\s*\[([^\]]*)\]\s*loop\b([\s\S]*?)\bend\s+loop\b/gi;

/** Does the loop body enable RLS on public.%I, with the loop variable as %I? */
const loopEnablesRls = (body, variable) =>
  new RegExp(
    String.raw`\bexecute\s+format\s*\(\s*'\s*${ALTER}(?:public\s*\.\s*)?%I${ENABLE}\s*'\s*,\s*${variable}\s*\)`,
    'i',
  ).test(body);

/** Postgres folds unquoted identifiers to lower case; quoted ones keep theirs. */
const bare = (ident) => (ident.startsWith('"') ? ident.slice(1, -1) : ident.toLowerCase());

/**
 * The ordered create / enable / disable / rename / drop events in one file,
 * public schema only. A rename also carries the new name as `to`.
 */
function eventsIn(sql) {
  const text = stripComments(sql);
  const events = [];

  for (const [kind, pattern] of Object.entries(STATEMENTS)) {
    for (const match of text.matchAll(pattern)) {
      const [, schema, name, to] = match;
      if (!isPublic(schema)) continue;
      const event = { at: match.index, kind, table: bare(name) };
      if (to !== undefined) event.to = bare(to);
      events.push(event);
    }
  }

  for (const match of text.matchAll(DROP)) {
    for (const [, schema, name] of match[1].matchAll(NAME_IN_LIST)) {
      if (isPublic(schema)) events.push({ at: match.index, kind: 'drop', table: bare(name) });
    }
  }

  for (const match of text.matchAll(FOREACH_LOOP)) {
    const [, variable, array, body] = match;
    if (!loopEnablesRls(body, variable)) continue;
    for (const [, table] of array.matchAll(/'([^']*)'/g)) {
      events.push({ at: match.index, kind: 'enable', table });
    }
  }

  return events.sort((a, b) => a.at - b.at);
}

/**
 * @param {{ name: string, sql: string }[]} files migrations, in the order they run
 * @returns {string[]} sorted bare names of public tables that exist without RLS
 */
export function findTablesWithoutRls(files) {
  const created = new Set();
  const enabled = new Set();

  for (const { sql } of files) {
    for (const { kind, table, to } of eventsIn(sql)) {
      if (kind === 'create') created.add(table);
      else if (kind === 'enable') enabled.add(table);
      else if (kind === 'disable') enabled.delete(table);
      else if (kind === 'rename') {
        // The table and its RLS state move to the new name; the old name is free.
        if (created.delete(table)) created.add(to);
        if (enabled.delete(table)) enabled.add(to);
        else enabled.delete(to);
      } else {
        created.delete(table);
        enabled.delete(table);
      }
    }
  }

  return [...created].filter((table) => !enabled.has(table)).sort();
}

function main(dir) {
  let names;
  try {
    if (!statSync(dir).isDirectory()) throw new Error('not a directory');
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => !entry.isDirectory() && entry.name.endsWith('.sql'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    console.error(`check-migrations: cannot read migrations directory ${dir}: ${error.message}`);
    return 2;
  }
  if (names.length === 0) {
    console.error(`check-migrations: no .sql files in ${dir}`);
    return 2;
  }

  const files = [];
  for (const name of names) {
    const path = join(dir, name);
    try {
      files.push({ name, sql: readFileSync(path, 'utf8') });
    } catch (error) {
      console.error(`check-migrations: cannot read migration file ${path}: ${error.message}`);
      return 2;
    }
  }
  const missing = findTablesWithoutRls(files);
  if (missing.length === 0) {
    console.log(`check-migrations: ${names.length} migration file(s) in ${dir}, every public table has row level security enabled`);
    return 0;
  }
  for (const table of missing) {
    console.error(`check-migrations: public.${table} is created without "enable row level security"`);
  }
  return 1;
}

const runDirectly =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (runDirectly) {
  process.exitCode = main(process.argv[2] ?? join('supabase', 'migrations'));
}
