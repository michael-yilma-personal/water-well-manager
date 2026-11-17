-- Test helpers. Loaded inside the transaction of every test file and rolled
-- back with it, so nothing here outlives a run.
--
-- Every check is one call that returns one line:
--     ok - <name>
--     FAIL - <name> :: <what happened>
-- The statement under test is passed as text and executed as the given actor
-- inside a subtransaction that is always undone, so checks never depend on
-- each other and a missing table is a FAIL line, not an aborted file.
--
-- Actors:
--     null          the connecting role (postgres): bypasses RLS, used for facts
--     'anon'        role anon, no user
--     'service'     role service_role (the key the admin-users function holds)
--     anything else role authenticated with JWT sub = t.uid(<label>), the
--                   standard Supabase impersonation:
--                     set local role authenticated;
--                     set local request.jwt.claims = '{"sub": ..., "role": "authenticated"}'

create schema t;
grant usage on schema t to public;

-- A stable id for a label, so fixtures and checks can name rows and users.
create function t.uid(label text) returns uuid
language sql immutable
as $$ select md5('drill-db-test:' || label)::uuid $$;

create function t._become(actor text) returns void
language plpgsql
as $f$
begin
  if actor is null then
    return;
  elsif actor = 'anon' then
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
    perform set_config('role', 'anon', true);
  elsif actor = 'service' then
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    perform set_config('role', 'service_role', true);
  else
    perform set_config('request.jwt.claims',
      json_build_object('sub', t.uid(actor), 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
  end if;
end
$f$;

-- Run q as actor and undo it. state '00000' means it ran; n is the row count
-- (rows returned by a SELECT or a RETURNING, rows changed otherwise); val is
-- the first column of the first row when want_value is set.
create function t._try(actor text, q text, want_value boolean,
                       out state text, out n bigint, out val text, out msg text)
language plpgsql
as $f$
declare
  v text;
  c bigint;
begin
  begin
    perform t._become(actor);
    if want_value then
      execute q into v;
    else
      execute q;
      get diagnostics c = row_count;
    end if;
    -- Undo the statement and the role switch, carrying the result out.
    raise exception using errcode = 'TR001',
      message = coalesce(c::text, ''), detail = coalesce(v, '<null>');
  exception
    when sqlstate 'TR001' then
      get stacked diagnostics msg = message_text, val = pg_exception_detail;
      state := '00000';
      n := nullif(msg, '')::bigint;
      msg := null;
    when others then
      state := sqlstate;
      msg := sqlerrm;
  end;
end
$f$;

-- A fixture registers itself here before it loads and removes the entry once
-- it has verified itself. While an entry remains, every check fails as "not
-- checked": without its fixture a negative check ("B cannot read A's row")
-- would pass for the wrong reason, because there is no row.
create table t.blockers (what text primary key);

create function t._line(name text, pass boolean, detail text) returns text
language plpgsql stable
as $f$
declare
  blocked text;
begin
  select string_agg(what, ', ' order by what) into blocked from t.blockers;
  if blocked is not null then
    return 'FAIL - ' || name || ' :: not checked: ' || blocked || ' did not load';
  end if;
  if pass then
    return 'ok - ' || name;
  end if;
  return 'FAIL - ' || name || ' :: ' || replace(coalesce(detail, ''), E'\n', ' ');
end
$f$;

-- q returns one boolean; the check passes when it is true.
create function t.ok(name text, actor text, q text) returns text
language plpgsql
as $f$
declare r record;
begin
  r := t._try(actor, q, true);
  return t._line(name, r.state = '00000' and r.val in ('true', 't'),
    case when r.state = '00000' then 'expected true, got ' || r.val
         else 'error ' || r.state || ': ' || r.msg end);
end
$f$;

create function t.ok(name text, q text) returns text
language sql
as $$ select t.ok(name, null, q) $$;

-- q runs without error and returns or changes exactly `expected` rows.
create function t.rows(name text, actor text, q text, expected bigint) returns text
language plpgsql
as $f$
declare r record;
begin
  r := t._try(actor, q, false);
  return t._line(name, r.state = '00000' and r.n = expected,
    case when r.state = '00000' then 'expected ' || expected || ' row(s), got ' || r.n
         else 'expected ' || expected || ' row(s), got error ' || r.state || ': ' || r.msg end);
end
$f$;

-- q is refused: it raises 42501 (insufficient privilege, which is also what a
-- failed RLS check raises), or it runs and returns or changes no row at all.
-- Any other error fails the check, so a typo in a test cannot pass as "refused".
create function t.none(name text, actor text, q text) returns text
language plpgsql
as $f$
declare r record;
begin
  r := t._try(actor, q, false);
  return t._line(name, r.state = '42501' or (r.state = '00000' and r.n = 0),
    case when r.state = '00000' then 'expected no row or 42501, but ' || r.n || ' row(s) were returned or changed'
         else 'expected no row or 42501, got error ' || r.state || ': ' || r.msg end);
end
$f$;

-- q raises one of the given SQLSTATEs.
create function t.throws(name text, actor text, q text, variadic states text[]) returns text
language plpgsql
as $f$
declare r record;
begin
  r := t._try(actor, q, false);
  return t._line(name, r.state = any (states),
    case when r.state = '00000' then 'expected error ' || array_to_string(states, ' or ') || ', but it succeeded (' || r.n || ' row(s))'
         else 'expected error ' || array_to_string(states, ' or ') || ', got ' || r.state || ': ' || r.msg end);
end
$f$;

-- ---------------------------------------------------------------------------
-- The four record tables
-- ---------------------------------------------------------------------------

-- `col` is a content column an author may change; for pipe_records it is one
-- a reviewer may correct too.
create table t.tables (tbl text primary key, col text not null, is_child boolean not null);
insert into t.tables values
  ('boreholes',       'name',      false),
  ('pipe_records',    'formation', true),
  ('drilling_events', 'title',     true),
  ('shift_logs',      'notes',     true);
grant select on t.tables to public;

-- The id of the fixture row of table `tbl` that carries tag `tag`.
create function t.rid(tbl text, tag text) returns uuid
language sql immutable
as $$ select t.uid(tbl || ':' || tag) $$;

-- An INSERT for one of the four tables with only the required columns.
-- org is sent only when it is not null: a null means "the client sent no
-- org_id", which is what every installed build does.
create function t.ins(tbl text, id uuid, borehole uuid, author uuid, org uuid default null)
returns text
language sql immutable
as $$
  select case tbl
    when 'boreholes' then
      format('insert into public.boreholes (id, name, created_by, recorded_at%s) values (%L, ''test hole'', %L, now()%s)',
             case when org is null then '' else ', org_id' end, id, author,
             case when org is null then '' else format(', %L', org) end)
    when 'pipe_records' then
      format('insert into public.pipe_records (id, borehole_id, pipe_number, start_depth, end_depth, formation, created_by, recorded_at%s) values (%L, %L, 1, 0, 6, ''Clay'', %L, now()%s)',
             case when org is null then '' else ', org_id' end, id, borehole, author,
             case when org is null then '' else format(', %L', org) end)
    else
      format('insert into public.%I (id, borehole_id, created_by, recorded_at%s) values (%L, %L, %L, now()%s)',
             tbl,
             case when org is null then '' else ', org_id' end, id, borehole, author,
             case when org is null then '' else format(', %L', org) end)
  end
$$;

-- Like t.rows, but the statement is KEPT (until the file's transaction rolls
-- back). For steps later checks build on, done as a real user would do them.
create function t.did(name text, actor text, q text, expected bigint) returns text
language plpgsql
as $f$
declare
  c bigint;
  state text;
  msg text;
begin
  begin
    perform t._become(actor);
    execute q;
    get diagnostics c = row_count;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
  exception when others then
    -- The subtransaction is undone, and the role switch with it.
    state := sqlstate;
    msg := sqlerrm;
  end;
  return t._line(name, state is null and c = expected,
    case when state is null then 'expected ' || expected || ' row(s), got ' || c
         else 'expected ' || expected || ' row(s), got error ' || state || ': ' || msg end);
end
$f$;
