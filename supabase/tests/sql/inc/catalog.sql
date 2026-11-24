-- t.catalog(): everything the migrations may touch, one line per object, as
-- lib/snapshot.sql lists it (local.sh compares that between databases; this
-- is the same list as a function, so that two moments of ONE transaction can
-- be compared where only one database exists, as in CI). Requires
-- lib/helpers.sql. Read-only.

create function t.catalog() returns table (line text)
language sql stable
as $f$
  select 'tables|' || c.relname || '|kind=' || c.relkind::text || '|rls=' || c.relrowsecurity || '|force=' || c.relforcerowsecurity
  from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'S')

  union all
  select 'columns|' || c.relname || '.' || a.attname || '|' || format_type(a.atttypid, a.atttypmod)
         || '|notnull=' || a.attnotnull || '|default=' || coalesce(pg_get_expr(d.adbin, d.adrelid), '')
         || '|identity=' || a.attidentity::text
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped

  union all
  select 'constraints|' || con.conrelid::regclass || '.' || con.conname || '|' || pg_get_constraintdef(con.oid)
  from pg_constraint con
  join pg_class c on c.oid = con.conrelid
  where c.relnamespace = 'public'::regnamespace

  union all
  select 'indexes|' || indexdef from pg_indexes where schemaname = 'public'

  union all
  select 'policies|' || schemaname || '.' || tablename || '.' || policyname || '|' || permissive || '|' || cmd
         || '|roles=' || array_to_string(roles, ',') || '|using=' || coalesce(qual, '') || '|check=' || coalesce(with_check, '')
  from pg_policies where schemaname in ('public', 'storage')

  union all
  select 'functions|' || p.oid::regprocedure || '|returns=' || pg_get_function_result(p.oid)
         || '|volatile=' || p.provolatile::text || '|definer=' || p.prosecdef
         || '|config=' || coalesce(array_to_string(p.proconfig, ','), '')
         || '|body=' || md5(p.prosrc)
         || '|acl=' || coalesce((select string_agg(x::text, ',' order by x::text) from unnest(p.proacl) x), 'default')
  from pg_proc p where p.pronamespace = 'public'::regnamespace

  union all
  select 'triggers|' || tg.tgrelid::regclass || '.' || tg.tgname || '|enabled=' || tg.tgenabled::text || '|' || pg_get_triggerdef(tg.oid)
  from pg_trigger tg
  join pg_class c on c.oid = tg.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where not tg.tgisinternal and n.nspname in ('public', 'auth', 'storage')

  union all
  select 'grants|' || table_schema || '.' || table_name || '|' || grantee || '|' || string_agg(privilege_type, ',' order by privilege_type)
  from information_schema.role_table_grants
  where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
  group by table_schema, table_name, grantee

  union all
  select 'column_grants|' || table_schema || '.' || table_name || '.' || column_name || '|' || grantee || '|' || string_agg(privilege_type, ',' order by privilege_type)
  from information_schema.column_privileges cp
  where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
    and not exists (select 1 from information_schema.role_table_grants tg
                    where tg.table_schema = cp.table_schema and tg.table_name = cp.table_name
                      and tg.grantee = cp.grantee and tg.privilege_type = cp.privilege_type)
  group by table_schema, table_name, column_name, grantee
$f$;

-- Named copies of the catalog, and how two of them differ.
create table t.catalogs (tag text, line text);

create function t.keep_catalog(tag_ text) returns text
language sql
as $$
  with d as (delete from t.catalogs where tag = tag_),
       i as (insert into t.catalogs select tag_, line from t.catalog() returning 1)
  select '' from (select count(*) from i) x
$$;

-- '' when the two are the same; otherwise the first differing lines, each
-- marked with the copy that has it.
create function t.catalog_diff(a text, b text) returns text
language sql stable
as $$
  select coalesce(string_agg(x, ' ;; ' order by x), '') from (
    select x from (
      (select a || ' only: ' || left(line, 160) as x from t.catalogs where tag = a
         and line not in (select line from t.catalogs where tag = b))
      union all
      (select b || ' only: ' || left(line, 160) from t.catalogs where tag = b
         and line not in (select line from t.catalogs where tag = a))
    ) u order by x limit 6) v
$$;

-- The check: the two copies are the same, and neither is empty.
create function t.same_catalog(name text, a text, b text) returns text
language plpgsql
as $f$
declare
  na int;
  nb int;
  d text;
begin
  select count(*) into na from t.catalogs where tag = a;
  select count(*) into nb from t.catalogs where tag = b;
  d := t.catalog_diff(a, b);
  return t._line(name, na > 50 and nb > 50 and d = '',
    case when na <= 50 or nb <= 50 then 'not checked, a copy of the catalog is missing (' || na || ' and ' || nb || ' lines)'
         else d end);
end
$f$;
