-- Criterion 25: after the tenancy migrations the privileges of the API roles
-- on `public` are explicit, and the same whether the database started with
-- Supabase's hosted default privileges or with none (CI's image).
--
--   service_role   ALL on every table, USAGE on every sequence
--   authenticated  SELECT, INSERT, UPDATE on the four record tables;
--                  SELECT on profiles, plus UPDATE of name and badge_number;
--                  SELECT on organizations, memberships, platform_admins, audit_log
--   anon           nothing
--
-- Read from the ACLs themselves (grants to the role or to PUBLIC), not through
-- has_table_privilege(), so that an unlisted privilege shows up by name.
-- plan: 68
begin;
\ir ../lib/helpers.sql

-- Table-level privileges `r` holds on public.<tbl>, sorted. MAINTAIN exists
-- from PostgreSQL 17 and comes with ALL there; it is left out for
-- service_role only, so the same expectation fits both server versions.
create function t.table_privs(r text, tbl text) returns text
language sql stable
as $$
  select coalesce(string_agg(distinct a.privilege_type, ',' order by a.privilege_type), 'none')
  from pg_class c, aclexplode(c.relacl) a
  where c.oid = to_regclass('public.' || tbl)
    and a.grantee in (0, (select oid from pg_roles where rolname = r))
    and not (r = 'service_role' and a.privilege_type = 'MAINTAIN')
$$;

-- Column-level privileges, as column:PRIVILEGE, sorted.
create function t.column_privs(r text, tbl text) returns text
language sql stable
as $$
  select coalesce(string_agg(distinct att.attname || ':' || a.privilege_type, ',' order by att.attname || ':' || a.privilege_type), 'none')
  from pg_attribute att, aclexplode(att.attacl) a
  where att.attrelid = to_regclass('public.' || tbl) and att.attnum > 0 and not att.attisdropped
    and a.grantee in (0, (select oid from pg_roles where rolname = r))
$$;

create table t.expected (tbl text, r text, table_privs text, column_privs text);
insert into t.expected
  select tbl, 'anon', 'none', 'none'
  from (values ('profiles'), ('boreholes'), ('pipe_records'), ('drilling_events'), ('shift_logs'),
               ('organizations'), ('memberships'), ('platform_admins'), ('audit_log')) v(tbl)
  union all
  select tbl, 'service_role', 'DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE', 'none'
  from (values ('profiles'), ('boreholes'), ('pipe_records'), ('drilling_events'), ('shift_logs'),
               ('organizations'), ('memberships'), ('platform_admins'), ('audit_log')) v(tbl)
  union all
  select tbl, 'authenticated', 'INSERT,SELECT,UPDATE', 'none'
  from (values ('boreholes'), ('pipe_records'), ('drilling_events'), ('shift_logs')) v(tbl)
  union all
  select tbl, 'authenticated', 'SELECT', 'none'
  from (values ('organizations'), ('memberships'), ('platform_admins'), ('audit_log')) v(tbl)
  union all
  select 'profiles', 'authenticated', 'SELECT', 'badge_number:UPDATE,name:UPDATE';

select t.ok(format('[c25] %s on %s: table privileges are exactly %s', r, tbl, table_privs),
  format($$ select to_regclass('public.%I') is not null and t.table_privs(%L, %L) = %L $$, tbl, r, tbl, table_privs))
  || coalesce(' (found: ' || nullif(t.table_privs(r, tbl), table_privs) || ')', '')
from t.expected order by tbl, r;

select t.ok(format('[c25] %s on %s: column privileges are exactly %s', r, tbl, column_privs),
  format($$ select to_regclass('public.%I') is not null and t.column_privs(%L, %L) = %L $$, tbl, r, tbl, column_privs))
  || coalesce(' (found: ' || nullif(t.column_privs(r, tbl), column_privs) || ')', '')
from t.expected order by tbl, r;

-- Whatever tables exist, now or later.
select t.ok('[c25] anon holds no privilege on any table in public, at table or column level',
  $$ select not exists (
       select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm')
         and (t.table_privs('anon', c.relname) <> 'none' or t.column_privs('anon', c.relname) <> 'none')) $$);
select t.ok('[c25] service_role holds ALL on every table in public',
  $$ select count(*) >= 9 and bool_and(t.table_privs('service_role', c.relname) = 'DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE')
     from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') $$);
select t.ok('[c25] service_role holds USAGE on every sequence in public (there is at least one: audit_log''s)',
  $$ select count(*) >= 1 and bool_and(has_sequence_privilege('service_role', c.oid, 'USAGE'))
     from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' $$);
select t.ok('[c25] authenticated holds nothing beyond SELECT, INSERT, UPDATE on any table in public',
  $$ select not exists (
       select 1 from pg_class c, aclexplode(c.relacl) a
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
         and a.grantee in (0, (select oid from pg_roles where rolname = 'authenticated'))
         and a.privilege_type not in ('SELECT', 'INSERT', 'UPDATE')) $$);

-- And in use: the key the admin-users function holds works on every table.
select t.ok(format('[c25] the service role reads %s', tbl), 'service',
  format('select count(*) >= 0 from public.%I', tbl))
from (values ('profiles'), ('boreholes'), ('pipe_records'), ('drilling_events'), ('shift_logs'),
             ('organizations'), ('memberships'), ('platform_admins'), ('audit_log')) v(tbl)
order by tbl;
select t.rows('[c25] the service role writes an audit row', 'service',
  $$ insert into public.audit_log (action) values ('test.service') $$, 1);

rollback;
select 'done';
