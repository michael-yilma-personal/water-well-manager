-- Criterion 14 on a database that started bare (no default privileges for the
-- API roles, as on CI's image): the rollback scripts ran; what the tenancy
-- migrations added is gone and what was there before is still there. The
-- exact-catalog comparison is made only where the starting point is the one
-- production has (see supabase/tests/local.sh). Run by local.sh only.
-- plan: 12
begin;
\ir ../lib/helpers.sql

select t.ok(format('[c14] after rollback: table %s is gone', tbl),
  format($$ select to_regclass('public.%I') is null $$, tbl))
from (values ('organizations'), ('memberships'), ('platform_admins'), ('audit_log')) v(tbl);
select t.ok(format('[c14] after rollback: %s has no org_id column', tbl),
  format($$ select not exists (select 1 from pg_attribute where attrelid = 'public.%I'::regclass and attname = 'org_id' and not attisdropped) $$, tbl))
from t.tables order by tbl;
select t.ok('[c14] after rollback: the tenancy functions are gone',
  $$ select not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
       and proname in ('is_org_member', 'has_org_role', 'saas_admin_roles', 'is_org_admin', 'is_platform_admin', 'my_organizations')) $$);
select t.ok('[c14] after rollback: the policies on public tables are exactly the fourteen pre-tenancy ones',
  $$ select count(*) = 14 and bool_and(policyname in (tablename || '_select', tablename || '_insert', tablename || '_update', 'profiles_update_own'))
     from pg_policies where schemaname = 'public' $$);
select t.ok('[c14] after rollback: no policy refers to organizations or memberships',
  $$ select not exists (select 1 from pg_policies where schemaname in ('public', 'storage')
       and coalesce(qual, '') || ' ' || coalesce(with_check, '') ~* '(org|membership)') $$);
select t.ok('[c14] after rollback: the five pre-tenancy tables are still there, with row level security',
  $$ select count(*) = 5 and bool_and(relrowsecurity) from pg_class
     where oid in ('public.profiles'::regclass, 'public.boreholes'::regclass, 'public.pipe_records'::regclass,
                   'public.drilling_events'::regclass, 'public.shift_logs'::regclass) $$);

rollback;
select 'done';
