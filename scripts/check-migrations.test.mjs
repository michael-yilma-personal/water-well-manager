// DEMO-1: static migration check - every public table created in
// supabase/migrations/ has row level security enabled.
//
// Derived from "DEMO-1 acceptance criteria" in docs/saas/IMPLEMENTATION_STATUS.md.
// Each describe block names the criterion it pins down.
//
// Run: node --test "scripts/*.test.mjs"

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { findTablesWithoutRls } from './check-migrations.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SCRIPT = join(HERE, 'check-migrations.mjs');
const REAL_MIGRATIONS = join(REPO_ROOT, 'supabase', 'migrations');

/** One file, named so that failures are easy to read. */
const one = (sql) => [{ name: '20260101000000_test.sql', sql }];

/** Shorthand: run the function over a single SQL string. */
const check = (sql) => findTablesWithoutRls(one(sql));

// ---------------------------------------------------------------------------
// Criterion 1 - the exported function and the shape of its result
// ---------------------------------------------------------------------------

describe('criterion 1: findTablesWithoutRls(files)', () => {
  it('is exported as a function', () => {
    assert.equal(typeof findTablesWithoutRls, 'function');
  });

  it('returns an empty array for no files', () => {
    assert.deepEqual(findTablesWithoutRls([]), []);
  });

  it('returns an empty array for a file with empty SQL', () => {
    assert.deepEqual(check(''), []);
  });

  it('returns an empty array for SQL that creates no table', () => {
    assert.deepEqual(
      check('create index if not exists a_idx on public.a (id);\nselect 1;'),
      [],
    );
  });

  it('reports a table that is created and never has RLS enabled', () => {
    assert.deepEqual(check('create table public.widgets (id uuid primary key);'), ['widgets']);
  });

  it('does not report a table that has RLS enabled in the same file', () => {
    assert.deepEqual(
      check(
        'create table public.widgets (id uuid primary key);\n' +
          'alter table public.widgets enable row level security;',
      ),
      [],
    );
  });

  it('does not report a table whose RLS is enabled in a different file', () => {
    assert.deepEqual(
      findTablesWithoutRls([
        { name: '20260101000000_a.sql', sql: 'create table public.widgets (id uuid);' },
        { name: '20260102000000_b.sql', sql: 'alter table public.widgets enable row level security;' },
      ]),
      [],
    );
  });

  it('reports only the tables that lack RLS when others have it', () => {
    assert.deepEqual(
      check(
        'create table public.alpha (id uuid);\n' +
          'create table public.beta (id uuid);\n' +
          'create table public.gamma (id uuid);\n' +
          'alter table public.beta enable row level security;',
      ),
      ['alpha', 'gamma'],
    );
  });

  it('returns the names sorted, whatever order the tables were created in', () => {
    assert.deepEqual(
      findTablesWithoutRls([
        { name: '20260103000000_c.sql', sql: 'create table public.mango (id uuid);' },
        { name: '20260101000000_a.sql', sql: 'create table public.zebra (id uuid);\ncreate table public.apple (id uuid);' },
        { name: '20260102000000_b.sql', sql: 'create table public.banana (id uuid);' },
      ]),
      ['apple', 'banana', 'mango', 'zebra'],
    );
  });

  it('reports a table once when it is created in more than one file', () => {
    assert.deepEqual(
      findTablesWithoutRls([
        { name: '20260101000000_a.sql', sql: 'create table if not exists public.widgets (id uuid);' },
        { name: '20260102000000_b.sql', sql: 'create table if not exists public.widgets (id uuid);' },
        { name: '20260103000000_c.sql', sql: 'CREATE TABLE widgets (id uuid);' },
      ]),
      ['widgets'],
    );
  });

  it('returns bare names: no schema prefix and no quotes', () => {
    const result = check('create table "public"."widgets" (id uuid);\ncreate table public.gadgets (id uuid);');
    assert.deepEqual(result, ['gadgets', 'widgets']);
  });

  it('enabling RLS on one table does not cover a table whose name merely starts the same', () => {
    assert.deepEqual(
      check(
        'create table public.user (id uuid);\n' +
          'create table public.users (id uuid);\n' +
          'create table public.user_roles (id uuid);\n' +
          'alter table public.users enable row level security;',
      ),
      ['user', 'user_roles'],
    );
  });

  it('enabling RLS on a table that was never created reports nothing', () => {
    assert.deepEqual(check('alter table public.ghost enable row level security;'), []);
  });

  it('does not throw on malformed SQL and still reports nothing it cannot name', () => {
    for (const sql of [
      'create table',
      'create table if not exists',
      'alter table enable row level security',
      'create table (((',
      '/* never closed create table public.a (id uuid);',
      "execute format('alter table public.%I enable row level security', t);",
      'foreach t in array array[',
      '$$ $$ $$ ;;; \u0000 ￿',
      ')'.repeat(2000),
    ]) {
      const result = check(sql);
      assert.ok(Array.isArray(result), `expected an array for: ${sql.slice(0, 40)}`);
      assert.deepEqual(result, [], `expected nothing reported for: ${sql.slice(0, 40)}`);
    }
  });

  it('malformed SQL around a real create table does not hide the table', () => {
    assert.deepEqual(
      check('create table (((;\ncreate table public.widgets (id uuid);\nalter table enable row level security;'),
      ['widgets'],
    );
  });

  it('handles a large hostile input without hanging', () => {
    // Guards against catastrophic backtracking; the test runner's own timeout
    // is the failure signal, not a wall-clock assertion.
    const noise = 'alter table '.repeat(5000) + 'public.a\n'.repeat(5000) + ' '.repeat(50000);
    assert.deepEqual(check(`create table public.widgets (id uuid);\n${noise}`), ['widgets']);
  });
});

// ---------------------------------------------------------------------------
// Criterion 2 - forms of create table
// ---------------------------------------------------------------------------

describe('criterion 2: recognising create table', () => {
  const forms = [
    ['plain, with public.', 'create table public.widgets (id uuid);'],
    ['plain, without schema', 'create table widgets (id uuid);'],
    ['if not exists, with public.', 'create table if not exists public.widgets (id uuid);'],
    ['if not exists, without schema', 'create table if not exists widgets (id uuid);'],
    ['upper case keywords', 'CREATE TABLE IF NOT EXISTS PUBLIC.widgets (id uuid);'],
    ['mixed case keywords', 'Create Table If Not Exists Public.widgets (id uuid);'],
    ['quoted table name', 'create table "widgets" (id uuid);'],
    ['quoted table name with public.', 'create table public."widgets" (id uuid);'],
    ['quoted schema and table', 'create table "public"."widgets" (id uuid);'],
    ['quoted schema, bare table', 'create table "public".widgets (id uuid);'],
    ['if not exists with quotes', 'create table if not exists "public"."widgets" (id uuid);'],
    ['keywords split across lines', 'create\n  table\n  if not exists\n  public.widgets\n(\n  id uuid\n);'],
    ['extra spaces and tabs', 'create   table\tif  not   exists   public.widgets(id uuid);'],
    ['no space before the column list', 'create table public.widgets(id uuid);'],
  ];

  for (const [label, sql] of forms) {
    it(`reports a table created as: ${label}`, () => {
      assert.deepEqual(check(sql), ['widgets']);
    });

    it(`accepts RLS for a table created as: ${label}`, () => {
      assert.deepEqual(check(`${sql}\nalter table public.widgets enable row level security;`), []);
    });
  }

  it('recognises an upper-case unquoted table name', () => {
    // Unquoted identifiers fold to lower case in Postgres. The criteria do not
    // say which case the reported name uses, so only the identity is asserted.
    const result = check('CREATE TABLE PUBLIC.WIDGETS (ID UUID);');
    assert.deepEqual(result.map((n) => n.toLowerCase()), ['widgets']);
  });

  it('matches create and enable written in different letter case', () => {
    assert.deepEqual(
      check('CREATE TABLE PUBLIC.WIDGETS (ID UUID);\nalter table public.widgets enable row level security;'),
      [],
    );
    assert.deepEqual(
      check('create table public.widgets (id uuid);\nALTER TABLE PUBLIC.WIDGETS ENABLE ROW LEVEL SECURITY;'),
      [],
    );
  });

  const otherSchemas = [
    ['storage.', 'create table storage.widgets (id uuid);'],
    ['auth.', 'create table auth.widgets (id uuid);'],
    ['if not exists auth.', 'create table if not exists auth.widgets (id uuid);'],
    ['quoted "storage".', 'create table "storage"."widgets" (id uuid);'],
    ['upper case AUTH.', 'CREATE TABLE AUTH.widgets (id uuid);'],
    ['a private schema', 'create table private.widgets (id uuid);'],
    ['a schema whose name starts with public', 'create table public_archive.widgets (id uuid);'],
  ];

  for (const [label, sql] of otherSchemas) {
    it(`ignores a table in another schema: ${label}`, () => {
      assert.deepEqual(check(sql), []);
    });
  }

  it('reports the public table and ignores a same-named table in another schema', () => {
    assert.deepEqual(
      check('create table auth.sessions (id uuid);\ncreate table public.sessions (id uuid);'),
      ['sessions'],
    );
  });

  it('RLS enabled on another schema\'s table does not cover the public table of the same name', () => {
    assert.deepEqual(
      check(
        'create table public.objects (id uuid);\n' +
          'alter table storage.objects enable row level security;',
      ),
      ['objects'],
    );
  });

  it('does not treat create index, create policy or create function as a table', () => {
    assert.deepEqual(
      check(
        'create index if not exists widgets_idx on public.widgets (id);\n' +
          'create policy widgets_select on public.widgets for select using (true);\n' +
          'create or replace function public.table_helper() returns void language sql as $$ select 1 $$;',
      ),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 3 - forms of alter table ... enable row level security
// ---------------------------------------------------------------------------

describe('criterion 3: recognising alter table ... enable row level security', () => {
  const create = 'create table public.widgets (id uuid);\n';

  const forms = [
    ['with public.', 'alter table public.widgets enable row level security;'],
    ['without schema', 'alter table widgets enable row level security;'],
    ['if exists', 'alter table if exists public.widgets enable row level security;'],
    ['if exists, without schema', 'alter table if exists widgets enable row level security;'],
    ['only', 'alter table only public.widgets enable row level security;'],
    ['only, without schema', 'alter table only widgets enable row level security;'],
    ['if exists only', 'alter table if exists only public.widgets enable row level security;'],
    ['upper case', 'ALTER TABLE PUBLIC.widgets ENABLE ROW LEVEL SECURITY;'],
    ['upper case with IF EXISTS ONLY', 'ALTER TABLE IF EXISTS ONLY public.widgets ENABLE ROW LEVEL SECURITY;'],
    ['mixed case', 'Alter Table Public.widgets Enable Row Level Security;'],
    ['quoted name', 'alter table "widgets" enable row level security;'],
    ['quoted schema and name', 'alter table "public"."widgets" enable row level security;'],
    ['aligned with extra spaces, as in this repository', 'alter table public.widgets        enable row level security;'],
    ['one line break', 'alter table public.widgets\n  enable row level security;'],
    ['a line break between every word', 'alter\ntable\npublic.widgets\nenable\nrow\nlevel\nsecurity\n;'],
    ['windows line endings', 'alter table public.widgets\r\n  enable row level security;\r\n'],
    ['tabs', 'alter\ttable\tpublic.widgets\tenable\trow\tlevel\tsecurity;'],
  ];

  for (const [label, sql] of forms) {
    it(`counts RLS enabled as: ${label}`, () => {
      assert.deepEqual(check(create + sql), []);
    });
  }

  it('counts RLS enabled before the create table statement appears', () => {
    // "never have row level security enabled in any file"
    assert.deepEqual(
      findTablesWithoutRls([
        { name: '20260101000000_a.sql', sql: 'alter table if exists public.widgets enable row level security;' },
        { name: '20260102000000_b.sql', sql: 'create table if not exists public.widgets (id uuid);' },
      ]),
      [],
    );
  });

  const notEnabling = [
    ['disable row level security', 'alter table public.widgets disable row level security;'],
    ['force row level security alone', 'alter table public.widgets force row level security;'],
    ['adding a column', 'alter table public.widgets add column note text;'],
    ['a policy without enabling', 'create policy widgets_select on public.widgets for select using (true);'],
    ['a grant', 'grant select on public.widgets to authenticated;'],
    ['enabling a trigger', 'alter table public.widgets enable trigger all;'],
    ['the words without the statement', 'select \'x\' as row, 1 as level, 2 as security from public.widgets;'],
  ];

  for (const [label, sql] of notEnabling) {
    it(`still reports the table when the only statement is: ${label}`, () => {
      assert.deepEqual(check(create + sql), ['widgets']);
    });
  }

  it('enabling RLS on a different table does not count', () => {
    assert.deepEqual(
      check(create + 'create table public.gadgets (id uuid);\nalter table public.gadgets enable row level security;'),
      ['widgets'],
    );
  });

  it('an unrelated alter table followed by another table\'s enable does not credit the first table', () => {
    assert.deepEqual(
      check(
        create +
          'create table public.gadgets (id uuid);\n' +
          'alter table public.widgets add column note text;\n' +
          'alter table public.gadgets enable row level security;',
      ),
      ['widgets'],
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 4 - the dynamic foreach / execute format pattern
// ---------------------------------------------------------------------------

/** The loop in the style of supabase/migrations/20260805000000_initial_schema.sql. */
const rlsLoop = (arrayLiteral) => `
do $$
declare
  t text;
begin
  foreach t in array ${arrayLiteral}
  loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end
$$;
`;

describe('criterion 4: execute format(...) inside a foreach loop', () => {
  const createThree =
    'create table public.boreholes (id uuid);\n' +
    'create table public.pipe_records (id uuid);\n' +
    'create table public.shift_logs (id uuid);\n';

  it('counts for every table named in the array', () => {
    assert.deepEqual(check(createThree + rlsLoop("array['boreholes', 'pipe_records', 'shift_logs']")), []);
  });

  it('counts for the two-element array given in the criterion', () => {
    assert.deepEqual(
      check("create table public.a (id uuid);\ncreate table public.b (id uuid);\n" + rlsLoop("array['a', 'b']")),
      [],
    );
  });

  it('still reports a table that is not in the array', () => {
    assert.deepEqual(check(createThree + rlsLoop("array['boreholes', 'shift_logs']")), ['pipe_records']);
  });

  it('counts for a single-element array', () => {
    assert.deepEqual(check(createThree + rlsLoop("array['pipe_records']")), ['boreholes', 'shift_logs']);
  });

  it('counts when the array is spread across lines', () => {
    assert.deepEqual(
      check(createThree + rlsLoop("array[\n    'boreholes',\n    'pipe_records',\n    'shift_logs'\n  ]")),
      [],
    );
  });

  it('counts when the array has no spaces after the commas', () => {
    assert.deepEqual(check(createThree + rlsLoop("array['boreholes','pipe_records','shift_logs']")), []);
  });

  it('counts when written in upper case', () => {
    const sql = `
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['boreholes', 'pipe_records', 'shift_logs']
  LOOP
    EXECUTE FORMAT('ALTER TABLE PUBLIC.%I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END
$$;`;
    assert.deepEqual(check(createThree + sql), []);
  });

  it('counts when the loop is in a later file than the create table', () => {
    assert.deepEqual(
      findTablesWithoutRls([
        { name: '20260101000000_a.sql', sql: createThree },
        { name: '20260102000000_b.sql', sql: rlsLoop("array['boreholes', 'pipe_records', 'shift_logs']") },
      ]),
      [],
    );
  });

  it('counts when the loop also runs other statements, as the loops in this repository do', () => {
    const sql = `
do $$
declare
  t text;
begin
  foreach t in array array['boreholes', 'pipe_records', 'shift_logs']
  loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy %I_select on public.%I for select using (created_by = auth.uid())',
      t, t);
  end loop;
end
$$;`;
    assert.deepEqual(check(createThree + sql), []);
  });

  it('a foreach loop that never enables RLS does not count', () => {
    // Shape copied from supabase/migrations/20260928000000_review_pipe_corrections.sql.
    const sql = `
do $$
declare
  t text;
begin
  foreach t in array array['boreholes', 'pipe_records', 'shift_logs']
  loop
    execute format('alter table public.%I add column if not exists modified_at timestamptz', t);
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format(
      'create policy %I_select on public.%I for select '
      'using (created_by = auth.uid())',
      t, t);
    execute format('revoke delete on public.%I from anon', t);
  end loop;
end
$$;`;
    assert.deepEqual(check(createThree + sql), ['boreholes', 'pipe_records', 'shift_logs']);
  });

  it('a loop that disables RLS does not count', () => {
    const sql = rlsLoop("array['boreholes', 'pipe_records', 'shift_logs']").replace('enable', 'disable');
    assert.deepEqual(check(createThree + sql), ['boreholes', 'pipe_records', 'shift_logs']);
  });

  it('an array in one loop does not get credit from the enable in a separate loop', () => {
    const otherLoop = `
do $$
declare
  t text;
begin
  foreach t in array array['pipe_records', 'shift_logs']
  loop
    execute format('revoke delete on public.%I from anon', t);
  end loop;
end
$$;`;
    assert.deepEqual(
      check(createThree + rlsLoop("array['boreholes']") + otherLoop),
      ['pipe_records', 'shift_logs'],
    );
    assert.deepEqual(
      check(createThree + otherLoop + rlsLoop("array['boreholes']")),
      ['pipe_records', 'shift_logs'],
    );
  });

  it('an array literal elsewhere in the file is not a list of protected tables', () => {
    assert.deepEqual(
      check(createThree + "select array['boreholes', 'pipe_records', 'shift_logs'];"),
      ['boreholes', 'pipe_records', 'shift_logs'],
    );
  });

  it('a commented-out execute inside the loop does not count', () => {
    const sql = rlsLoop("array['boreholes', 'pipe_records', 'shift_logs']").replace(
      '    execute format(',
      '    -- execute format(',
    );
    assert.deepEqual(check(createThree + sql), ['boreholes', 'pipe_records', 'shift_logs']);
  });

  it('a whole loop inside a block comment does not count', () => {
    const sql = `/*${rlsLoop("array['boreholes', 'pipe_records', 'shift_logs']")}*/`;
    assert.deepEqual(check(createThree + sql), ['boreholes', 'pipe_records', 'shift_logs']);
  });

  it('a table name commented out of the array is not covered', () => {
    const sql = rlsLoop("array[\n    'boreholes',\n    -- 'pipe_records',\n    'shift_logs'\n  ]");
    assert.deepEqual(check(createThree + sql), ['pipe_records']);
  });
});

// ---------------------------------------------------------------------------
// Criterion 5 - SQL comments are ignored
// ---------------------------------------------------------------------------

describe('criterion 5: text inside SQL comments is ignored', () => {
  const create = 'create table public.widgets (id uuid);\n';

  it('a line-commented enable does not count', () => {
    assert.deepEqual(check(create + '-- alter table public.widgets enable row level security;'), ['widgets']);
  });

  it('an indented line-commented enable does not count', () => {
    assert.deepEqual(check(create + '    --alter table public.widgets enable row level security;'), ['widgets']);
  });

  it('an enable in a trailing line comment does not count', () => {
    assert.deepEqual(
      check(create + 'select 1; -- alter table public.widgets enable row level security;'),
      ['widgets'],
    );
  });

  it('a block-commented enable does not count', () => {
    assert.deepEqual(check(create + '/* alter table public.widgets enable row level security; */'), ['widgets']);
  });

  it('a multi-line block-commented enable does not count', () => {
    assert.deepEqual(
      check(create + '/*\n  alter table public.widgets\n    enable row level security;\n*/'),
      ['widgets'],
    );
  });

  it('an enable whose statement is half inside a comment does not count', () => {
    assert.deepEqual(
      check(create + 'alter table public.widgets -- enable row level security;\n  add column note text;'),
      ['widgets'],
    );
    assert.deepEqual(
      check(create + 'alter table public.widgets /* enable row level security */ add column note text;'),
      ['widgets'],
    );
  });

  it('a line-commented create table is not reported', () => {
    assert.deepEqual(check('-- create table public.widgets (id uuid);'), []);
  });

  it('a block-commented create table is not reported', () => {
    assert.deepEqual(check('/* create table public.widgets (id uuid); */'), []);
    assert.deepEqual(check('/*\ncreate table public.widgets (\n  id uuid\n);\n*/'), []);
  });

  it('a create table mentioned in prose inside a comment is not reported', () => {
    assert.deepEqual(
      check('-- We used to create table public.legacy here, but no longer.\nselect 1;'),
      [],
    );
  });

  it('a real statement after a line comment on the previous line still counts', () => {
    assert.deepEqual(
      check(
        '-- widgets\n' + create + '-- Row Level Security\nalter table public.widgets enable row level security;',
      ),
      [],
    );
  });

  it('a real statement after a block comment on the same line still counts', () => {
    assert.deepEqual(
      check('/* table */ create table public.widgets (id uuid); /* rls */ alter table public.widgets enable row level security;'),
      [],
    );
    assert.deepEqual(check('/* table */ create table public.widgets (id uuid);'), ['widgets']);
  });

  it('a comment in the middle of a real enable statement does not break it', () => {
    assert.deepEqual(
      check(create + 'alter table public.widgets -- tenant data\n  enable row level security;'),
      [],
    );
    assert.deepEqual(
      check(create + 'alter table public.widgets /* tenant data */ enable row level security;'),
      [],
    );
  });

  it('a comment in the middle of a real create table does not hide it', () => {
    assert.deepEqual(check('create table -- the main one\n  public.widgets (id uuid);'), ['widgets']);
    assert.deepEqual(check('create table /* the main one */ public.widgets (id uuid);'), ['widgets']);
  });

  it('several block comments on one line are each closed at their own end marker', () => {
    // A greedy match from the first /* to the last */ would swallow the create.
    assert.deepEqual(
      check('/* one */ create table public.widgets (id uuid); /* two */'),
      ['widgets'],
    );
  });

  it('a commented-out create next to a real one reports only the real one', () => {
    assert.deepEqual(
      check('-- create table public.old_widgets (id uuid);\ncreate table public.widgets (id uuid);'),
      ['widgets'],
    );
  });

  it('a file that is nothing but comments reports nothing', () => {
    assert.deepEqual(check('-- nothing here\n/* or here */\n--'), []);
  });
});

// ---------------------------------------------------------------------------
// Criterion 6 - dropped tables
// ---------------------------------------------------------------------------

describe('criterion 6: a table created and later dropped is not reported', () => {
  const create = 'create table public.widgets (id uuid);\n';

  const forms = [
    ['drop table public.', 'drop table public.widgets;'],
    ['drop table without schema', 'drop table widgets;'],
    ['drop table if exists', 'drop table if exists public.widgets;'],
    ['drop table ... cascade', 'drop table if exists public.widgets cascade;'],
    ['upper case', 'DROP TABLE IF EXISTS PUBLIC.widgets;'],
    ['quoted', 'drop table "public"."widgets";'],
    ['across line breaks', 'drop table\n  if exists\n  public.widgets;'],
  ];

  for (const [label, sql] of forms) {
    it(`does not report a table dropped with: ${label}`, () => {
      assert.deepEqual(check(create + sql), []);
    });
  }

  it('does not report a table dropped in a later file', () => {
    assert.deepEqual(
      findTablesWithoutRls([
        { name: '20260101000000_a.sql', sql: create },
        { name: '20260102000000_b.sql', sql: 'drop table public.widgets;' },
      ]),
      [],
    );
  });

  it('dropping one table does not hide another', () => {
    assert.deepEqual(
      check(create + 'create table public.gadgets (id uuid);\ndrop table public.gadgets;'),
      ['widgets'],
    );
  });

  it('dropping a table whose name merely starts the same does not hide the table', () => {
    assert.deepEqual(
      check(create + 'create table public.widgets_old (id uuid);\ndrop table public.widgets_old;'),
      ['widgets'],
    );
  });

  it('dropping another schema\'s table of the same name does not hide the public table', () => {
    assert.deepEqual(check(create + 'drop table archive.widgets;'), ['widgets']);
  });

  it('a commented-out drop table does not hide the table', () => {
    assert.deepEqual(check(create + '-- drop table public.widgets;'), ['widgets']);
    assert.deepEqual(check(create + '/* drop table public.widgets; */'), ['widgets']);
  });

  it('dropping a policy, index or column does not hide the table', () => {
    assert.deepEqual(
      check(
        create +
          'drop policy if exists widgets_select on public.widgets;\n' +
          'drop index if exists widgets_idx;\n' +
          'alter table public.widgets drop column note;',
      ),
      ['widgets'],
    );
  });

  it('a table dropped and then created again in the same file is reported', () => {
    // "created and LATER dropped": here the drop comes first, so the table exists.
    assert.deepEqual(
      check('drop table if exists public.widgets;\ncreate table public.widgets (id uuid);'),
      ['widgets'],
    );
  });

  it('a table created, dropped and created again without RLS is reported', () => {
    assert.deepEqual(
      check(create + 'drop table public.widgets;\ncreate table public.widgets (id uuid, note text);'),
      ['widgets'],
    );
  });
});

// ---------------------------------------------------------------------------
// Criterion 7 - the command
// ---------------------------------------------------------------------------

/** Run the CLI. Never throws on a non-zero exit. */
function runCli(args, options = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: options.cwd ?? REPO_ROOT,
  });
  assert.equal(result.error, undefined, `could not start the command: ${result.error}`);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}\n${result.stderr}`,
  };
}

/** A temp directory under os.tmpdir(), removed when the test ends. */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'check-migrations-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Lines of output that mention `name` as a whole word. */
function linesMentioning(output, name) {
  const word = new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`);
  return output.split(/\r?\n/).filter((line) => word.test(line));
}

describe('criterion 7: node scripts/check-migrations.mjs [dir]', () => {
  it('exits 0 and prints a confirmation when every table has RLS', (t) => {
    const dir = tempDir(t);
    writeFileSync(
      join(dir, '20260101000000_ok.sql'),
      'create table public.zz_widgets (id uuid);\nalter table public.zz_widgets enable row level security;\n',
    );
    const r = runCli([dir]);
    assert.equal(r.status, 0, r.output);
    assert.notEqual(r.output.trim(), '', 'expected a confirmation message');
    assert.deepEqual(linesMentioning(r.output, 'zz_widgets'), [], 'a protected table must not be listed');
  });

  it('exits 0 when the directory has .sql files that create no tables', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, '20260101000000_none.sql'), 'select 1;\n');
    const r = runCli([dir]);
    assert.equal(r.status, 0, r.output);
    assert.notEqual(r.output.trim(), '');
  });

  it('exits 1 and names the table when one table lacks RLS', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, '20260101000000_bad.sql'), 'create table public.zz_widgets (id uuid);\n');
    const r = runCli([dir]);
    assert.equal(r.status, 1, r.output);
    assert.equal(linesMentioning(r.output, 'zz_widgets').length, 1, r.output);
  });

  it('exits 1 and prints one line per offending table', (t) => {
    const dir = tempDir(t);
    writeFileSync(
      join(dir, '20260101000000_a.sql'),
      'create table public.zz_alpha (id uuid);\ncreate table public.zz_beta (id uuid);\n' +
        'create table public.zz_safe (id uuid);\nalter table public.zz_safe enable row level security;\n',
    );
    writeFileSync(join(dir, '20260102000000_b.sql'), 'create table public.zz_gamma (id uuid);\n');
    const r = runCli([dir]);
    assert.equal(r.status, 1, r.output);

    const offending = ['zz_alpha', 'zz_beta', 'zz_gamma'];
    for (const name of offending) {
      const lines = linesMentioning(r.output, name);
      assert.equal(lines.length, 1, `expected exactly one line for ${name}:\n${r.output}`);
      for (const other of offending.filter((n) => n !== name)) {
        assert.deepEqual(
          linesMentioning(lines[0], other),
          [],
          `${name} and ${other} share a line:\n${r.output}`,
        );
      }
    }
    assert.deepEqual(linesMentioning(r.output, 'zz_safe'), [], 'a protected table must not be listed');
  });

  it('reads every .sql file: RLS enabled in a second file counts', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, '20260101000000_a.sql'), 'create table public.zz_widgets (id uuid);\n');
    writeFileSync(
      join(dir, '20260102000000_b.sql'),
      'alter table public.zz_widgets enable row level security;\n',
    );
    const r = runCli([dir]);
    assert.equal(r.status, 0, r.output);
  });

  it('reads only .sql files: a create table in another kind of file is not reported', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, '20260101000000_ok.sql'), 'select 1;\n');
    writeFileSync(join(dir, 'notes.txt'), 'create table public.zz_widgets (id uuid);\n');
    writeFileSync(join(dir, 'README.md'), 'create table public.zz_gadgets (id uuid);\n');
    const r = runCli([dir]);
    assert.equal(r.status, 0, r.output);
  });

  it('reads only .sql files: an enable in another kind of file does not count', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, '20260101000000_bad.sql'), 'create table public.zz_widgets (id uuid);\n');
    writeFileSync(join(dir, 'fix.txt'), 'alter table public.zz_widgets enable row level security;\n');
    const r = runCli([dir]);
    assert.equal(r.status, 1, r.output);
    assert.equal(linesMentioning(r.output, 'zz_widgets').length, 1, r.output);
  });

  it('exits 2 with a message when the directory does not exist', (t) => {
    const dir = join(tempDir(t), 'does-not-exist');
    const r = runCli([dir]);
    assert.equal(r.status, 2, r.output);
    assert.notEqual(r.output.trim(), '', 'expected a message');
  });

  it('exits 2 with a message when the directory is empty', (t) => {
    const dir = tempDir(t);
    const r = runCli([dir]);
    assert.equal(r.status, 2, r.output);
    assert.notEqual(r.output.trim(), '', 'expected a message');
  });

  it('exits 2 when the directory has files but none of them is .sql', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, 'notes.txt'), 'create table public.zz_widgets (id uuid);\n');
    writeFileSync(join(dir, 'schema.sql.bak'), 'create table public.zz_gadgets (id uuid);\n');
    const r = runCli([dir]);
    assert.equal(r.status, 2, r.output);
    assert.notEqual(r.output.trim(), '', 'expected a message');
  });

  it('exits 2 when the path is a file rather than a directory', (t) => {
    const dir = tempDir(t);
    const file = join(dir, '20260101000000_ok.sql');
    writeFileSync(file, 'select 1;\n');
    const r = runCli([file]);
    assert.equal(r.status, 2, r.output);
    assert.notEqual(r.output.trim(), '', 'expected a message');
  });

  it('a wrong path never looks like a pass or like a finding', (t) => {
    const r = runCli([join(tempDir(t), 'supabase', 'migratons')]);
    assert.notEqual(r.status, 0, r.output);
    assert.notEqual(r.status, 1, r.output);
  });

  it('defaults to supabase/migrations under the current directory: finding', (t) => {
    const cwd = tempDir(t);
    mkdirSync(join(cwd, 'supabase', 'migrations'), { recursive: true });
    writeFileSync(
      join(cwd, 'supabase', 'migrations', '20260101000000_bad.sql'),
      'create table public.zz_widgets (id uuid);\n',
    );
    const r = runCli([], { cwd });
    assert.equal(r.status, 1, r.output);
    assert.equal(linesMentioning(r.output, 'zz_widgets').length, 1, r.output);
  });

  it('defaults to supabase/migrations under the current directory: missing', (t) => {
    const cwd = tempDir(t);
    const r = runCli([], { cwd });
    assert.equal(r.status, 2, r.output);
    assert.notEqual(r.output.trim(), '', 'expected a message');
  });
});

// ---------------------------------------------------------------------------
// Criterion 8 - this repository's migrations
// ---------------------------------------------------------------------------

function readRealMigrations() {
  return readdirSync(REAL_MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(REAL_MIGRATIONS, name), 'utf8') }));
}

describe('criterion 8: the migrations in this repository', () => {
  it('the function reports nothing for supabase/migrations', () => {
    const files = readRealMigrations();
    assert.ok(files.length >= 6, `expected at least six migrations, found ${files.length}`);
    assert.deepEqual(findTablesWithoutRls(files), []);
  });

  it('the command exits 0 for supabase/migrations given as an argument', () => {
    const r = runCli([REAL_MIGRATIONS]);
    assert.equal(r.status, 0, r.output);
    assert.notEqual(r.output.trim(), '', 'expected a confirmation message');
  });

  it('the command exits 0 with no argument, run from the repository root', () => {
    const r = runCli([], { cwd: REPO_ROOT });
    assert.equal(r.status, 0, r.output);
  });

  it('the pass is not vacuous: with the enable statements removed, the tables are reported', () => {
    const enable = /^alter table public\.\w+\s+enable row level security;[ \t]*$/gim;
    let removed = 0;
    const files = readRealMigrations().map(({ name, sql }) => ({
      name,
      sql: sql.replace(enable, () => {
        removed += 1;
        return '';
      }),
    }));
    assert.ok(removed > 0, 'expected to find enable statements to remove; the fixture has drifted');

    const result = findTablesWithoutRls(files);
    for (const table of ['boreholes', 'drilling_events', 'pipe_records', 'profiles', 'shift_logs']) {
      assert.ok(result.includes(table), `expected ${table} to be reported, got ${JSON.stringify(result)}`);
    }
  });
});

// ===========================================================================
// VALIDATION (Test Engineer, validate mode, after the implementation existed)
//
// Everything below was added after reading scripts/check-migrations.mjs and
// trying to break it. Each describe block says whether it is a defect against
// the eight criteria or a hardening beyond them, and each test title says
// which way the script errs:
//   [false pass]  an unprotected public table is NOT reported  (dangerous)
//   [false alarm] a protected or absent table IS reported      (lesser)
//   [guard]       passes today; pins the behaviour a fix must keep
// ===========================================================================

const ENABLE_WIDGETS = 'alter table public.widgets enable row level security;';
const CREATE_WIDGETS = 'create table public.widgets (id uuid primary key);';

// Defect against criterion 5. Postgres block comments nest: the comment below
// ends at the LAST "*/", so everything in it is "text inside SQL comments".
// Wrapping a section that already holds a /* ... */ note in an outer /* ... */
// is the ordinary way to comment a block out of a migration.
describe('validation: criterion 5 - nested block comments (defect)', () => {
  it('[false pass] an enable commented out by an outer block comment does not count', () => {
    const sql = `
      ${CREATE_WIDGETS}
      /* switched off for now
         /* was needed for the dashboard */
         ${ENABLE_WIDGETS}
      */
    `;
    assert.deepEqual(check(sql), ['widgets']);
  });

  it('[false alarm] a create table commented out by an outer block comment is not reported', () => {
    const sql = `
      /* not yet
         /* draft */
         create table public.drafts (id uuid primary key);
      */
    `;
    assert.deepEqual(check(sql), []);
  });

  it('[guard] a statement after the end of a nested comment is live again', () => {
    const sql = `
      /* outer /* inner */ still a comment */
      ${CREATE_WIDGETS}
    `;
    assert.deepEqual(check(sql), ['widgets']);
  });
});

// Hardening (the script header documents it as a known limit). Judged
// realistic for this repository: a Supabase storage bucket is created with
// allowed_mime_types = array['image/*'], and from that "/*" to the next "*/"
// (or the end of the file) every create table is invisible to the check.
describe('validation: "/*" inside a string literal is not a comment start (hardening)', () => {
  const bucket =
    "insert into storage.buckets (id, name, public, allowed_mime_types)\n" +
    "values ('site-photos', 'site-photos', false, array['image/*']);\n";

  it('[false pass] a create table after a mime-type pattern is still reported', () => {
    assert.deepEqual(check(`${bucket}${CREATE_WIDGETS}`), ['widgets']);
  });

  it('[false pass] ... also when a real block comment follows later in the file', () => {
    const sql = `${bucket}${CREATE_WIDGETS}
      /* gadgets are protected */
      create table public.gadgets (id uuid primary key);
      alter table public.gadgets enable row level security;
    `;
    assert.deepEqual(check(sql), ['widgets']);
  });

  it('[false pass] a create table after a URL pattern in a string is still reported', () => {
    const sql = `insert into public.settings (key, value) values ('allowed', 'https://example.com/*');
      create table public.widgets (id uuid primary key);`;
    assert.deepEqual(check(sql), ['widgets']);
  });

  it('[false pass] a create table in a LATER statement of a dollar-quoted body is still reported', () => {
    const sql = `do $$
      begin
        raise notice 'allowing image/* uploads';
        create table public.widgets (id uuid primary key);
      end $$;`;
    assert.deepEqual(check(sql), ['widgets']);
  });

  it('[false alarm] an enable after a mime-type pattern still counts', () => {
    assert.deepEqual(check(`${CREATE_WIDGETS}\n${bucket}${ENABLE_WIDGETS}`), []);
  });

  it('[false pass] the command exits 1, not 0, for such a file', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, '20260101000000_bucket.sql'), `${bucket}${CREATE_WIDGETS}\n`);
    const r = runCli([dir]);
    assert.equal(r.status, 1, r.output);
    assert.equal(linesMentioning(r.output, 'widgets').length, 1, r.output);
  });

  it('[guard] a real comment that mentions a glob is still a comment', () => {
    const sql = `-- see docs/*.md, then: ${ENABLE_WIDGETS}
      ${CREATE_WIDGETS}`;
    assert.deepEqual(check(sql), ['widgets']);
  });
});

// Hardening (documented limit: "never looks at whether RLS is later
// disabled"). Judged realistic: "alter table ... disable row level security"
// is the usual quick fix when a query comes back empty, and a migration that
// does it leaves the table open while this check keeps passing.
describe('validation: disable row level security after enable (hardening)', () => {
  const disable = 'alter table public.widgets disable row level security;';

  it('[false pass] a table whose RLS is enabled and then disabled is reported', () => {
    assert.deepEqual(check(`${CREATE_WIDGETS}\n${ENABLE_WIDGETS}\n${disable}`), ['widgets']);
  });

  it('[false pass] ... also when the disable is in a later file', () => {
    assert.deepEqual(
      findTablesWithoutRls([
        { name: '20260101000000_a.sql', sql: `${CREATE_WIDGETS}\n${ENABLE_WIDGETS}` },
        {
          name: '20260201000000_b.sql',
          sql: 'ALTER TABLE IF EXISTS ONLY "public"."widgets"\n  DISABLE ROW LEVEL SECURITY;',
        },
      ]),
      ['widgets'],
    );
  });

  it('[false pass] ... also when the enable came from the foreach loop', () => {
    const sql = `create table public.boreholes (id uuid);
      ${rlsLoop("array['boreholes']")}
      alter table public.boreholes disable row level security;`;
    assert.deepEqual(check(sql), ['boreholes']);
  });

  it('[guard] disabled and then enabled again is not reported', () => {
    assert.deepEqual(check(`${CREATE_WIDGETS}\n${ENABLE_WIDGETS}\n${disable}\n${ENABLE_WIDGETS}`), []);
  });

  it('[guard] disabling another table, or another schema\'s table, changes nothing', () => {
    const sql = `${CREATE_WIDGETS}\n${ENABLE_WIDGETS}
      alter table public.widgets_archive disable row level security;
      alter table private.widgets disable row level security;`;
    assert.deepEqual(check(sql), []);
  });

  it('[guard] a commented-out disable changes nothing', () => {
    assert.deepEqual(check(`${CREATE_WIDGETS}\n${ENABLE_WIDGETS}\n-- ${disable}`), []);
  });
});

// Hardening (not in the criteria, not in the header's list of limits). The
// rebuild-a-table migration renames the old table aside and creates a new one
// under the old name. RLS follows the renamed table; the new one has none, but
// the name is already marked as enabled.
describe('validation: alter table ... rename to (hardening)', () => {
  it('[false pass] a table re-created under the name of a renamed table is reported', () => {
    const sql = `${CREATE_WIDGETS}
      ${ENABLE_WIDGETS}
      alter table public.widgets rename to widgets_old;
      create table public.widgets (id uuid primary key, name text);
      insert into public.widgets (id) select id from public.widgets_old;
      drop table public.widgets_old;`;
    assert.deepEqual(check(sql), ['widgets']);
  });

  it('[false pass] ... also when the rebuild is in a later file', () => {
    assert.deepEqual(
      findTablesWithoutRls([
        { name: '20260101000000_a.sql', sql: `${CREATE_WIDGETS}\n${ENABLE_WIDGETS}` },
        {
          name: '20260201000000_b.sql',
          sql: `alter table if exists public.widgets rename to widgets_old;
                create table public.widgets (id uuid primary key);`,
        },
      ]),
      ['widgets'],
    );
  });

  it('[false alarm] a table renamed and then protected under its new name is not reported', () => {
    const sql = `${CREATE_WIDGETS}
      alter table public.widgets rename to gadgets;
      alter table public.gadgets enable row level security;`;
    assert.deepEqual(check(sql), []);
  });

  it('[guard] renaming a protected table reports nothing', () => {
    const sql = `${CREATE_WIDGETS}\n${ENABLE_WIDGETS}\nalter table public.widgets rename to gadgets;`;
    assert.deepEqual(check(sql), []);
  });

  it('[guard] renaming a column or a constraint is not renaming the table', () => {
    const sql = `${CREATE_WIDGETS}
      alter table public.widgets rename column id to widget_id;
      alter table public.widgets rename constraint widgets_pkey to widgets_pk;`;
    assert.deepEqual(check(sql), ['widgets']);
  });
});

// Defect against criterion 6 as worded ("a table that is created and later
// dropped is not reported"); the header documents it as a limit. Lesser: it
// only ever reports too much.
describe('validation: criterion 6 - drop table with several names (false alarm)', () => {
  const two = 'create table public.widgets (id uuid);\ncreate table public.gadgets (id uuid);\n';

  it('[false alarm] every table named in one drop table is forgotten', () => {
    assert.deepEqual(check(`${two}drop table public.widgets, public.gadgets;`), []);
  });

  it('[false alarm] ... with if exists, cascade and a line break', () => {
    assert.deepEqual(check(`${two}DROP TABLE IF EXISTS widgets,\n  "gadgets" CASCADE;`), []);
  });

  it('[guard] a multi-name drop does not hide a table it does not name', () => {
    const sql = `${two}create table public.gizmos (id uuid);\ndrop table public.widgets, public.gadgets;`;
    assert.ok(check(sql).includes('gizmos'), JSON.stringify(check(sql)));
  });

  it('[guard] a multi-name drop does not reach into the next statement', () => {
    const sql = `${two}drop table public.widgets;\nselect 1, gadgets from x;`;
    assert.deepEqual(check(sql), ['gadgets']);
  });
});

// Hardening of criterion 7. Exit 1 means "these tables lack RLS"; a file the
// script could not read is neither a finding nor a pass, and today it is an
// uncaught exception (stack trace, exit 1, no check-migrations message).
describe('validation: criterion 7 - a .sql file that cannot be read (hardening)', () => {
  it('exits 2 with a check-migrations message, not a stack trace', (t) => {
    const dir = tempDir(t);
    writeFileSync(join(dir, '20260101000000_ok.sql'), 'select 1;\n');
    symlinkSync(join(dir, 'does-not-exist.sql'), join(dir, '20260102000000_dangling.sql'));
    const r = runCli([dir]);
    assert.equal(r.status, 2, r.output);
    assert.match(r.stderr, /check-migrations: .*20260102000000_dangling\.sql/);
    assert.doesNotMatch(r.output, /^\s+at .*\(node:/m, 'expected no stack trace');
  });

  it('[guard] an unreadable file never looks like a pass', (t) => {
    const dir = tempDir(t);
    symlinkSync(join(dir, 'does-not-exist.sql'), join(dir, '20260102000000_dangling.sql'));
    const r = runCli([dir]);
    assert.notEqual(r.status, 0, r.output);
  });
});
