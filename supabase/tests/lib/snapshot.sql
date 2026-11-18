-- A text snapshot of everything the tenancy migrations may touch, one line per
-- object, each line starting with its section. supabase/tests/local.sh takes
-- it before the migrations and after the rollback scripts and compares the
-- two, section by section (criterion 14), and before and after applying
-- saas_core a second time (criterion 4). Read-only.
\pset format unaligned
\pset tuples_only on

select line from (
  select 'tables|' || c.relname || '|kind=' || c.relkind::text || '|rls=' || c.relrowsecurity || '|force=' || c.relforcerowsecurity as line
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
    -- only grants that exist at column level, not the expansion of table grants
    and not exists (select 1 from information_schema.role_table_grants tg
                    where tg.table_schema = cp.table_schema and tg.table_name = cp.table_name
                      and tg.grantee = cp.grantee and tg.privilege_type = cp.privilege_type)
  group by table_schema, table_name, column_name, grantee

  union all
  select 'buckets|' || id || '|public=' || public from storage.buckets
) s
order by line collate "C";
