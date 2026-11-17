-- Criterion 14, rehearsed where the real Supabase image is available: inside
-- one transaction, run the rollback scripts, check the pre-tenancy state is
-- back and the installed build's behaviour with it, re-apply the migrations,
-- check again, and roll the whole thing back. Nothing is left changed.
--
-- What is and is not asserted after the rollback: the catalog facts that are
-- the same wherever the database started (tenancy objects gone, the fourteen
-- pre-tenancy policies, the six triggers). The installed build's BEHAVIOUR
-- after a rollback is not asserted here: it needs the privileges the database
-- had before the migrations, and on CI's image those were none at all. That
-- proof, with the full catalog comparison, is in supabase/tests/local.sh on a
-- database that starts with the hosted default privileges, as production
-- does. After rolling forward again the behaviour must be back in any world.
--
-- run.sh passes the four file paths as psql variables and refuses to run this
-- file when one of them is missing or contains transaction control.
-- supabase/tests/local.sh additionally compares a full catalog snapshot
-- before the migration and after the rollback on a scratch database.
-- plan: 104
begin;
\ir ../lib/helpers.sql

select t.ok('[c14] precondition: tenancy is applied before the rehearsal',
  $$ select to_regclass('public.organizations') is not null
        and exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped) $$);

-- Decision 31: the Drill rollback refuses only when MORE than one organization
-- holds record rows. A second organization with a member and no records does
-- not stop it; everything below must hold with one in place. (The refusal
-- itself is tried by run.sh, guards/rollback_refuses.sql.)
insert into public.organizations (id, name) values (t.uid('org_empty'), 'No records');
insert into auth.users (id, email) values (t.uid('rb_member'), 'rb_member@db-test.invalid');
delete from public.memberships where user_id = t.uid('rb_member');
insert into public.memberships (org_id, user_id, role) values (t.uid('org_empty'), t.uid('rb_member'), 'Driller');

\i :rollback_drill
\i :rollback_core

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
  $$ select array_agg(tablename || '.' || policyname order by tablename, policyname) = array[
       'boreholes.boreholes_insert', 'boreholes.boreholes_select', 'boreholes.boreholes_update',
       'drilling_events.drilling_events_insert', 'drilling_events.drilling_events_select', 'drilling_events.drilling_events_update',
       'pipe_records.pipe_records_insert', 'pipe_records.pipe_records_select', 'pipe_records.pipe_records_update',
       'profiles.profiles_select', 'profiles.profiles_update_own',
       'shift_logs.shift_logs_insert', 'shift_logs.shift_logs_select', 'shift_logs.shift_logs_update']
     from pg_policies where schemaname = 'public' $$);
select t.ok('[c14] after rollback: the photo policies are exactly the two pre-tenancy ones',
  $$ select array_agg(policyname::text order by policyname) = array['drilling_photos_insert', 'drilling_photos_select']
     from pg_policies where schemaname = 'storage' and tablename = 'objects'
       and (policyname like 'drilling%' or coalesce(qual, '') || coalesce(with_check, '') like '%drilling-photos%') $$);
select t.ok('[c14] after rollback: no policy refers to organizations or memberships',
  $$ select not exists (select 1 from pg_policies where schemaname in ('public', 'storage')
       and coalesce(qual, '') || ' ' || coalesce(with_check, '') ~* '(org|membership)') $$);
select t.ok('[c14] after rollback: the record read policies use is_reviewer() again',
  $$ select count(*) = 4 from pg_policies where schemaname = 'public' and policyname like '%\_select'
       and tablename <> 'profiles' and qual like '%is_reviewer()%' and qual like '%created_by = auth.uid()%' $$);
select t.ok('[c14] after rollback: the triggers calling public functions are exactly the six pre-tenancy ones',
  $$ select array_agg(tg.tgrelid::regclass::text || '.' || tg.tgname order by tg.tgrelid::regclass::text || '.' || tg.tgname) = array[
       'auth.users.on_auth_user_created',
       'boreholes.boreholes_touch_modified_at',
       'drilling_events.drilling_events_touch_modified_at',
       'pipe_records.pipe_records_guard_update',
       'pipe_records.pipe_records_touch_modified_at',
       'shift_logs.shift_logs_touch_modified_at']
     from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
     where not tg.tgisinternal and p.pronamespace = 'public'::regnamespace $$);

select t.ok('[c14] after rollback: the pre-tenancy functions are still there',
  $$ select to_regprocedure('public.is_admin()') is not null and to_regprocedure('public.is_reviewer()') is not null
        and to_regprocedure('public.handle_new_user()') is not null and to_regprocedure('public.pipe_records_guard_update()') is not null
        and to_regprocedure('public.touch_modified_at()') is not null $$);
select t.ok('[c14] after rollback: the five pre-tenancy tables are still there, with row level security',
  $$ select count(*) = 5 and bool_and(relrowsecurity) from pg_class
     where oid in ('public.profiles'::regclass, 'public.boreholes'::regclass, 'public.pipe_records'::regclass,
                   'public.drilling_events'::regclass, 'public.shift_logs'::regclass) $$);

\i :mig_core
\i :mig_drill

select t.ok('[c14] rolled forward again: one organization, named "Founding organization"',
  $$ select count(*) = 1 and min(name) = 'Founding organization' from public.organizations $$);
select t.ok(format('[c14] rolled forward again: %s.org_id is back, not null, with no null in it', tbl),
  format($$ select (select attnotnull from pg_attribute where attrelid = 'public.%1$I'::regclass and attname = 'org_id' and not attisdropped)
               and not exists (select 1 from public.%1$I where org_id is null) $$, tbl))
from t.tables order by tbl;

savepoint after_roll_forward;
\ir inc/legacy_client.sql
rollback to savepoint after_roll_forward;

rollback;
select 'done';
