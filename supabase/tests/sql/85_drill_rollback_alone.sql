-- Criterion 14: the Drill rollback "drops what the migration added". Tried
-- here on its own, WITHOUT the saas_core rollback after it, because that one
-- drops the foundation's tables and with them anything the Drill rollback
-- forgot to take off them. What must be left is the foundation exactly as
-- criteria 1 and 2 describe it, with its rows.
--
-- Inside one transaction that is rolled back. run.sh passes the file path and
-- refuses to run this file when a migration or rollback file is missing or
-- contains transaction control.
-- plan: 17
begin;
\ir ../lib/helpers.sql

create function t.cols(tbl text) returns text
language sql stable
as $$
  select string_agg(a.attname, ',' order by a.attname)
  from pg_attribute a
  where a.attrelid = to_regclass('public.' || tbl) and a.attnum > 0 and not a.attisdropped
$$;

select t.ok('[c14] precondition: tenancy is applied',
  $$ select to_regclass('public.organizations') is not null
        and exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped) $$);

insert into auth.users (id, email) values (t.uid('ra_member'), 'ra_member@db-test.invalid');
create table t.before as
  select (select count(*) from public.organizations) as orgs,
         (select count(*) from public.memberships) as members;

\i :rollback_drill

create table t.fns_left as
  select p.oid::regprocedure::text as sig from pg_proc p where p.pronamespace = 'public'::regnamespace;

-- Every function the Drill migration defines in public, read from the file
-- itself, so that one it gains later is covered without touching this test.
-- saas_admin_roles() is the foundation's: the migration only replaces it.
\set drill_text `cat :'mig_drill'`
create table t.drill_fns as
  select distinct lower(m[2]) as name
  from regexp_matches(:'drill_text', 'create\s+(or\s+replace\s+)?function\s+public\.([a-z_0-9]+)', 'gi') m;

select t.ok('[c14] after the Drill rollback alone: no function the Drill migration defines is left in public (left over: '
            || coalesce((select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) from pg_proc p
                         where p.pronamespace = 'public'::regnamespace
                           and p.proname in (select name from t.drill_fns where name <> 'saas_admin_roles')), 'none') || ')',
  $$ select (select count(*) from t.drill_fns) >= 5
        and not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
                          and p.proname in (select name from t.drill_fns where name <> 'saas_admin_roles')) $$);

select t.ok('[c14] after the Drill rollback alone: organizations has exactly the columns of criterion 1 (found: ' || coalesce(t.cols('organizations'), 'no table') || ')',
  $$ select t.cols('organizations') = 'created_at,id,name' $$);
select t.ok('[c14] after the Drill rollback alone: memberships has exactly the columns of criterion 1 (found: ' || coalesce(t.cols('memberships'), 'no table') || ')',
  $$ select t.cols('memberships') = 'badge_number,created_at,org_id,role,status,user_id' $$);
select t.ok('[c14] ... the organizations and memberships themselves are kept',
  $$ select (select count(*) from public.organizations) = orgs and orgs >= 1
        and (select count(*) from public.memberships) = members and members >= 1 from t.before $$);
select t.ok('[c14] ... no index on a foundation table mentions anything but its own columns',
  $$ select not exists (select 1 from pg_indexes where schemaname = 'public'
       and tablename in ('organizations', 'memberships', 'platform_admins', 'audit_log') and indexdef ~* '(founding|ban)') $$);
select t.ok('[c14][c5] ... saas_admin_roles() is the foundation''s default again: {admin}',
  $$ select public.saas_admin_roles() = array['admin'] $$);
select t.did('[c14][c5] ... and memberships.role takes any role name again (Drill''s vocabulary is gone)', null,
  format('insert into public.memberships (org_id, user_id, role) select id, %L, ''surveyor'' from public.organizations limit 1 on conflict (org_id, user_id) do update set role = excluded.role',
         t.uid('ra_member')), 1);
select t.ok('[c14] ... the triggers calling public functions are exactly the six pre-tenancy ones',
  $$ select array_agg(tg.tgrelid::regclass::text || '.' || tg.tgname order by tg.tgrelid::regclass::text || '.' || tg.tgname) = array[
       'auth.users.on_auth_user_created',
       'boreholes.boreholes_touch_modified_at',
       'drilling_events.drilling_events_touch_modified_at',
       'pipe_records.pipe_records_guard_update',
       'pipe_records.pipe_records_touch_modified_at',
       'shift_logs.shift_logs_touch_modified_at']
     from pg_trigger tg join pg_proc p on p.oid = tg.tgfoid
     where not tg.tgisinternal and p.pronamespace = 'public'::regnamespace $$);
select t.ok(format('[c14] ... %s has no org_id column', tbl),
  format($$ select not exists (select 1 from pg_attribute where attrelid = 'public.%I'::regclass and attname = 'org_id' and not attisdropped) $$, tbl))
from t.tables order by tbl;
select t.ok('[c14] ... no policy on a Drill table or on the photos refers to organizations or memberships',
  $$ select not exists (select 1 from pg_policies
       where (schemaname = 'storage' or (schemaname = 'public'
              and tablename in ('profiles', 'boreholes', 'pipe_records', 'drilling_events', 'shift_logs')))
         and coalesce(qual, '') || ' ' || coalesce(with_check, '') ~* '(org|membership)') $$);
select t.did('[c14] ... and creating an account still goes through (no trigger is left calling a dropped function)', null,
  format('insert into auth.users (id, email) values (%L, ''ra_after@db-test.invalid'')', t.uid('ra_after')), 1);
select t.did('[c14] ... as does a ban', null,
  format('update auth.users set banned_until = now() + interval ''876000 hours'' where id = %L', t.uid('ra_after')), 1);

-- Nothing of the foundation's, or older, was dropped along the way: every
-- function of a foundation that never had Drill on top of it (the saas_core
-- rollback and saas_core again, in this transaction) was there after the
-- Drill rollback. Last: it drops the foundation's rows.
\i :rollback_core
\i :mig_core

select t.ok('[c14] after the Drill rollback alone: every function of the foundation without Drill was still there (missing: '
            || coalesce((select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) from pg_proc p
                         where p.pronamespace = 'public'::regnamespace and p.oid::regprocedure::text not in (select sig from t.fns_left)), 'none')
            || ')',
  $$ select (select count(*) from t.fns_left) >= 6
        and not exists (select 1 from pg_proc p
                        where p.pronamespace = 'public'::regnamespace and p.oid::regprocedure::text not in (select sig from t.fns_left)) $$);

rollback;
select 'done';
