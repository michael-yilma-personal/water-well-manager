-- Structure and grants: criteria 1, 2, 5, 7, and the parts of today's schema
-- that criterion 10 says must stay ("No DELETE", role not self-editable).
-- plan: 97
begin;
\ir ../lib/helpers.sql

create function t.col(tbl text, col text) returns text
language sql stable
as $$
  select format_type(a.atttypid, a.atttypmod)
      || case when a.attnotnull then ' not null' else '' end
      || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
      || case when a.attidentity <> '' then ' identity' else '' end
  from pg_attribute a
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attrelid = to_regclass('public.' || tbl) and a.attname = col and not a.attisdropped
$$;

-- A foreign key from exactly (col) to the given table.
create function t.fk(tbl text, col text, ref text) returns boolean
language sql stable
as $$
  select exists (
    select 1 from pg_constraint c
    where c.contype = 'f'
      and c.conrelid = to_regclass('public.' || tbl)
      and c.confrelid = to_regclass(ref)
      and c.conkey = array[(select attnum from pg_attribute
                            where attrelid = c.conrelid and attname = col and not attisdropped)])
$$;

-- A valid index whose leading column is col.
create function t.indexed(tbl text, col text) returns boolean
language sql stable
as $$
  select exists (
    select 1 from pg_index i
    where i.indrelid = to_regclass('public.' || tbl) and i.indisvalid
      and i.indkey[0] = (select attnum from pg_attribute
                         where attrelid = i.indrelid and attname = col and not attisdropped))
$$;

create function t.pk(tbl text) returns text
language sql stable
as $$
  select pg_get_constraintdef(oid) from pg_constraint
  where contype = 'p' and conrelid = to_regclass('public.' || tbl)
$$;

-- ---------------------------------------------------------------------------
-- Today's schema (true before tenancy, and criterion 10 keeps it)
-- ---------------------------------------------------------------------------

select t.ok(format('[today] %s has row level security enabled', tbl),
  format($$ select relrowsecurity from pg_class where oid = to_regclass('public.%I') $$, tbl))
from (values ('profiles'), ('boreholes'), ('pipe_records'), ('drilling_events'), ('shift_logs')) v(tbl);

select t.ok(format('[today][c10] %s holds no DELETE privilege on %s', r, tbl),
  format($$ select not has_table_privilege(%L, 'public.%I', 'DELETE') $$, r, tbl))
from (values ('profiles'), ('boreholes'), ('pipe_records'), ('drilling_events'), ('shift_logs')) v(tbl),
     (values ('anon'), ('authenticated')) w(r)
order by tbl, r;

select t.ok(format('[today][c10] %s holds no UPDATE privilege on profiles.role', r),
  format($$ select not has_column_privilege(%L, 'public.profiles', 'role', 'UPDATE') $$, r))
from (values ('anon'), ('authenticated')) w(r);

select t.ok('[today][c10] the pipe-record column guard trigger is in place',
  $$ select exists (select 1 from pg_trigger
                    where tgrelid = 'public.pipe_records'::regclass and not tgisinternal
                      and tgfoid = 'public.pipe_records_guard_update()'::regprocedure and tgenabled <> 'D') $$);

-- ---------------------------------------------------------------------------
-- Criterion 1: foundation tables
-- ---------------------------------------------------------------------------

select t.ok(format('[c1] table %s exists with row level security enabled', tbl),
  format($$ select coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.%I')), false) $$, tbl))
from (values ('organizations'), ('memberships'), ('platform_admins'), ('audit_log')) v(tbl);

select t.ok(format('[c1] %s.%s is "%s"', tbl, col, pattern),
  format($$ select coalesce(t.col(%L, %L) like %L, false) $$, tbl, col, pattern))
from (values
  ('organizations',   'id',           'uuid not null default gen_random_uuid()'),
  ('organizations',   'name',         'text not null'),
  ('organizations',   'created_at',   'timestamp with time zone not null default now()'),
  ('memberships',     'org_id',       'uuid not null'),
  ('memberships',     'user_id',      'uuid not null'),
  ('memberships',     'role',         'text not null'),
  ('memberships',     'status',       'text not null default ''active''::text'),
  ('memberships',     'badge_number', 'text'),
  ('memberships',     'created_at',   'timestamp with time zone not null default now()'),
  ('platform_admins', 'user_id',      'uuid not null'),
  ('audit_log',       'id',           'bigint not null identity'),
  ('audit_log',       'at',           'timestamp with time zone%default now()'),
  ('audit_log',       'actor_id',     'uuid'),
  ('audit_log',       'org_id',       'uuid'),
  ('audit_log',       'action',       'text not null'),
  ('audit_log',       'target',       'text'),
  ('audit_log',       'details',      'jsonb')
) v(tbl, col, pattern);

select t.ok(format('[c1] the primary key of %s is %s', tbl, pk),
  format($$ select coalesce(t.pk(%L) = %L, false) $$, tbl, pk))
from (values
  ('organizations',   'PRIMARY KEY (id)'),
  ('memberships',     'PRIMARY KEY (org_id, user_id)'),
  ('platform_admins', 'PRIMARY KEY (user_id)'),
  ('audit_log',       'PRIMARY KEY (id)')
) v(tbl, pk);

select t.ok(format('[c1] %s.%s references %s', tbl, col, ref),
  format($$ select t.fk(%L, %L, %L) $$, tbl, col, ref))
from (values
  ('memberships',     'org_id',  'public.organizations'),
  ('memberships',     'user_id', 'auth.users'),
  ('platform_admins', 'user_id', 'auth.users')
) v(tbl, col, ref);

select t.ok('[c1] memberships has an index led by user_id',
  $$ select t.indexed('memberships', 'user_id') $$);

-- No write privilege of any kind, at table or column level.
select t.ok(format('[c1] %s holds no INSERT, UPDATE or DELETE privilege on %s', r, tbl),
  format($$ select to_regclass('public.%1$I') is not null
              and not has_any_column_privilege(%2$L, 'public.%1$I', 'INSERT')
              and not has_any_column_privilege(%2$L, 'public.%1$I', 'UPDATE')
              and not has_table_privilege(%2$L, 'public.%1$I', 'DELETE') $$, tbl, r))
from (values ('organizations'), ('memberships'), ('platform_admins'), ('audit_log')) v(tbl),
     (values ('anon'), ('authenticated')) w(r)
order by tbl, r;

-- ---------------------------------------------------------------------------
-- Criterion 2: helper functions
-- ---------------------------------------------------------------------------

select t.ok(format('[c2] function %s exists, returns %s, and is stable, security definer, search_path = public', sig, ret),
  format($$ select coalesce((
      select p.provolatile = 's' and p.prosecdef
         and p.proconfig @> array['search_path=public']
         and pg_get_function_result(p.oid) like %L
      from pg_proc p where p.oid = to_regprocedure(%L)), false) $$, ret, 'public.' || sig))
from (values
  ('is_org_member(uuid)',       'boolean'),
  ('has_org_role(uuid,text[])', 'boolean'),
  ('saas_admin_roles()',        'text[]'),
  ('is_org_admin(uuid)',        'boolean'),
  ('is_platform_admin()',       'boolean'),
  ('my_organizations()',        '%')
) v(sig, ret);

select t.ok('[c2] has_org_role takes its roles as a variadic argument',
  $$ select coalesce((select provariadic <> 0 from pg_proc
                      where oid = to_regprocedure('public.has_org_role(uuid,text[])')), false) $$);

select t.ok('[c2] my_organizations() returns the columns org_id, name, role, status',
  $$ select count(*) >= 0 from (select org_id, name, role, status from public.my_organizations()) x $$);

-- ---------------------------------------------------------------------------
-- Criterion 5: Drill's vocabulary
-- ---------------------------------------------------------------------------

select t.ok('[c5] saas_admin_roles() returns {Administrator}',
  $$ select public.saas_admin_roles() = array['Administrator'] $$);

-- ---------------------------------------------------------------------------
-- Criterion 7: org_id on the record tables
-- ---------------------------------------------------------------------------

select t.ok(format('[c7] %s.org_id is uuid not null', tbl),
  format($$ select coalesce(t.col(%L, 'org_id') = 'uuid not null', false) $$, tbl))
from t.tables order by tbl;
select t.ok(format('[c7] %s.org_id references organizations', tbl),
  format($$ select t.fk(%L, 'org_id', 'public.organizations') $$, tbl))
from t.tables order by tbl;
select t.ok(format('[c7] %s has an index led by org_id', tbl),
  format($$ select t.indexed(%L, 'org_id') $$, tbl))
from t.tables order by tbl;

-- ---------------------------------------------------------------------------
-- Criterion 22: TRUNCATE ignores row level security, and Supabase grants it
-- to the API roles on every new table unless a migration takes it away.
-- ---------------------------------------------------------------------------

select t.ok(format('[c22] %s holds no TRUNCATE privilege on %s', r, tbl),
  format($$ select to_regclass('public.%1$I') is not null and not has_table_privilege(%2$L, 'public.%1$I', 'TRUNCATE') $$, tbl, r))
from (values ('profiles'), ('boreholes'), ('pipe_records'), ('drilling_events'), ('shift_logs'),
             ('organizations'), ('memberships'), ('platform_admins'), ('audit_log')) v(tbl),
     (values ('anon'), ('authenticated')) w(r)
order by tbl, r;
select t.ok('[c22] no table in public grants TRUNCATE to anon or authenticated: ' ||
            coalesce((select string_agg(distinct c.relname, ', ' order by c.relname) from pg_class c
                      where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
                        and (has_table_privilege('anon', c.oid, 'TRUNCATE') or has_table_privilege('authenticated', c.oid, 'TRUNCATE'))),
                     'none does'),
  $$ select not exists (select 1 from pg_class c
       where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
         and (has_table_privilege('anon', c.oid, 'TRUNCATE') or has_table_privilege('authenticated', c.oid, 'TRUNCATE'))) $$);

-- ---------------------------------------------------------------------------
-- Criterion 23: deleting an account takes its memberships with it
-- ---------------------------------------------------------------------------

select t.ok('[c23] memberships.user_id references auth.users ON DELETE CASCADE',
  $$ select coalesce((select bool_or(c.confdeltype = 'c') from pg_constraint c
       where c.contype = 'f' and c.conrelid = to_regclass('public.memberships') and c.confrelid = 'auth.users'::regclass), false) $$);

-- ---------------------------------------------------------------------------
-- Criterion 6, on a database that had no data: exactly one organization
-- ---------------------------------------------------------------------------

select t.ok('[c6] exactly one organization exists, named "Founding organization"',
  $$ select count(*) = 1 and min(name) = 'Founding organization' from public.organizations $$);

rollback;
select 'done';
