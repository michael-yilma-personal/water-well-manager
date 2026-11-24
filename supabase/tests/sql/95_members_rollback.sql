-- SaaS Phase 2, task P2-1: the two member migrations applied again, rolled
-- back and rolled forward, inside one transaction that is rolled back.
--
--   "each safe to apply twice"   a second application changes nothing in the
--                                catalog (and, criteria 1 and 2, the
--                                foundation's re-application does not put its
--                                defaults over Drill's replacements)
--   criterion 13                 rollback: drill_members first, then
--                                saas_members; after both, the schema and the
--                                behaviour are those of Phase 1
--   criteria 1, 2                the foundation's defaults, seen with
--                                saas_members applied and drill_members not
--
-- "The schema of Phase 1" is checked two ways. Here, where only one database
-- exists (CI): the catalog after the two rollbacks must equal the catalog
-- after the Phase 1 migrations are themselves rolled back and applied afresh
-- in this transaction. In supabase/tests/local.sh: against a snapshot taken
-- before the member migrations were ever applied, and by running the whole
-- Phase 1 suite on the rolled-back database.
--
-- run.sh passes the file paths as psql variables and refuses to run this file
-- when one of them is missing or contains transaction control.
-- plan: 110
begin;
\ir ../lib/helpers.sql
\ir inc/members.sql
\ir inc/catalog.sql
\ir inc/marker_key.sql

create table t.founding as select id from public.organizations;
grant select on t.founding to public;
create function t.f() returns uuid language sql stable as $$ select id from t.founding $$;

create table t.fn_names (name text primary key);
insert into t.fn_names values
  ('saas_roles'), ('saas_member_record_count'), ('saas_add_member'), ('saas_set_member_role'),
  ('saas_set_member_badge'), ('saas_set_member_status'), ('saas_remove_member'),
  ('accept_membership'), ('decline_membership');

create function t.fns_present() returns int
language sql stable
as $$ select count(distinct p.proname)::int from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.proname in (select name from t.fn_names) $$;

create function t.roles() returns text
language plpgsql stable
as $f$
declare r text;
begin
  execute 'select array_to_string(array(select x from unnest(public.saas_roles()) x order by x), ''|'')' into r;
  return r;
exception when others then
  return 'error ' || sqlstate;
end
$f$;

select t.ok('[P2-1 c13] precondition: exactly one organization, and the member migrations are applied (the nine functions exist)',
  $$ select (select count(*) from public.organizations) = 1 and t.fns_present() = 9 $$);

-- An Administrator, a member with a record, and a member without, all in the
-- founding organization, made the way admin-users makes them.
insert into auth.users (id, email) values
  (t.uid('r_admin'),  'r_admin@db-test.invalid'),
  (t.uid('r_author'), 'r_author@db-test.invalid'),
  (t.uid('r_idle'),   'r_idle@db-test.invalid');
update public.profiles set role = 'Administrator' where id = t.uid('r_admin');
select t.did('[P2-1 c13] setup: a founding member logs a borehole', 'r_author',
  t.ins('boreholes', t.uid('boreholes:r_author'), null, t.uid('r_author')), 1);
select t.ok('[P2-1 c7] setup: with both migrations applied the member''s record counts: 1', 'service',
  format('select public.saas_member_record_count(%L, %L) = 1', t.f(), t.uid('r_author')));

-- ---------------------------------------------------------------------------
-- Applied a second time
-- ---------------------------------------------------------------------------

select t.keep_catalog('applied');

\i :mig_saas_members

select t.ok('[P2-1 c1] saas_members applied again ON TOP of Drill''s: saas_roles() is still Drill''s four roles, not the foundation''s default',
  $$ select t.roles() = 'Administrator|Data Logger|Driller|Supervisor' $$);
select t.ok('[P2-1 c2] ... and saas_member_record_count is still Drill''s: the member''s record still counts', 'service',
  format('select public.saas_member_record_count(%L, %L) = 1', t.f(), t.uid('r_author')));
select t.keep_catalog('saas twice');
select t.same_catalog('[P2-1] a second application of saas_members changes nothing in the catalog', 'applied', 'saas twice');

\i :mig_drill_members

select t.keep_catalog('both twice');
select t.same_catalog('[P2-1] a second application of drill_members changes nothing in the catalog', 'applied', 'both twice');
select t.ok('[P2-1] ... and the memberships are what they were',
  $$ select t.mo('r_admin', t.f()) = 'Administrator/active/-' and t.mo('r_author', t.f()) = 'Driller/active/-'
        and t.mo('r_idle', t.f()) = 'Driller/active/-' $$);
select t.rows('[P2-1] ... the functions still work after the second application: a role is changed', 'service',
  t.set_role(t.f(), t.uid('r_idle'), 'Supervisor', t.uid('r_admin')), 1);

-- ---------------------------------------------------------------------------
-- Criterion 13: drill_members rolled back first
-- ---------------------------------------------------------------------------

\i :rollback_drill_members

select t.ok('[P2-1 c13] after the drill_members rollback alone: the foundation''s nine functions are all still there (found: ' || t.fns_present() || ')',
  $$ select t.fns_present() = 9 $$);
select t.ok('[P2-1 c13] ... the Phase 1 tables, their role vocabulary and the founding mark are untouched',
  $$ select to_regclass('public.memberships') is not null and public.saas_admin_roles() = array['Administrator']
        and (select count(*) from public.organizations where is_founding) = 1 $$);
select t.did('[P2-1 c13] ... and creating an account still goes through (no trigger is left calling a dropped function)', null,
  format('insert into auth.users (id, email) values (%L, ''r_mid@db-test.invalid'')', t.uid('r_mid')), 1);

-- ---------------------------------------------------------------------------
-- Criterion 13: then saas_members
-- ---------------------------------------------------------------------------

\i :rollback_saas_members

select t.ok('[P2-1 c13] after both rollbacks: none of the nine functions is left in public (left: '
            || coalesce((select string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text) from pg_proc p
                         where p.pronamespace = 'public'::regnamespace and p.proname in (select name from t.fn_names)), 'none') || ')',
  $$ select t.fns_present() = 0 $$);
select t.keep_catalog('rolled back');

-- Behaviour of Phase 1: every new account is enrolled in the founding
-- organization, whatever its app_metadata says (the marker of criterion 8,
-- inc/marker_key.sql, means nothing any more).
insert into public.organizations (id, name) values (t.uid('org_second'), 'Second');
insert into auth.users (id, email, raw_app_meta_data)
  values (t.uid('r_marked'), 'r_marked@db-test.invalid', jsonb_build_object(:'marker_key', t.uid('org_second')::text));
select t.ok('[P2-1 c13][c27] after both rollbacks: an account created with the marker is enrolled in the founding organization, as in Phase 1',
  $$ select t.m('r_marked') = 'Driller/active/-' and t.mo('r_marked', t.f()) = 'Driller/active/-' $$);
delete from auth.users where id = t.uid('r_marked');
delete from public.organizations where id = t.uid('org_second');

select t.did('[P2-1 c13][c9] after both rollbacks: the Phase 1 mirror works: a profile''s role and badge are set', 'service',
  format('update public.profiles set role = ''Supervisor'', badge_number = ''R-1'' where id = %L', t.uid('r_idle')), 1);
select t.ok('[P2-1 c13][c9] ... and reach the founding membership',
  $$ select t.mo('r_idle', t.f()) = 'Supervisor/active/R-1' $$);
update auth.users set banned_until = now() + interval '876000 hours' where id = t.uid('r_idle');
select t.ok('[P2-1 c13][c9] ... a ban deactivates it',
  $$ select t.mo('r_idle', t.f()) = 'Supervisor/deactivated/R-1' $$);
update auth.users set banned_until = null where id = t.uid('r_idle');
select t.ok('[P2-1 c13][c28] ... and its lifting brings it back',
  $$ select t.mo('r_idle', t.f()) = 'Supervisor/active/R-1' $$);
select t.ok('[P2-1 c13] ... the member''s records and memberships survived the rollbacks',
  $$ select (select count(*) from public.boreholes where id = t.uid('boreholes:r_author')) = 1
        and t.mo('r_admin', t.f()) = 'Administrator/active/-' and t.mo('r_author', t.f()) = 'Driller/active/-' $$);

-- The installed build's behaviour, as after the Phase 1 migrations.
savepoint after_members_rollback;
\ir inc/legacy_client.sql
rollback to savepoint after_members_rollback;

-- ---------------------------------------------------------------------------
-- Criteria 1 and 2: the foundation's defaults (saas_members without Drill's)
-- ---------------------------------------------------------------------------

\i :mig_saas_members

select t.ok('[P2-1 c1] with saas_members applied and drill_members not: saas_roles() is the foundation''s default, {admin,member}', 'service',
  $$ select public.saas_roles() = array['admin', 'member'] $$);
select t.ok('[P2-1 c2] ... and saas_member_record_count is the foundation''s default: 0, for a member who has a record', 'service',
  format('select public.saas_member_record_count(%L, %L) = 0', t.f(), t.uid('r_author')));
select t.ok('[P2-1 c1][c2] ... all nine functions are back',
  $$ select t.fns_present() = 9 $$);

\i :mig_drill_members

select t.ok('[P2-1 c7] rolled forward again: saas_roles() is Drill''s four roles',
  $$ select t.roles() = 'Administrator|Data Logger|Driller|Supervisor' $$);
select t.ok('[P2-1 c7] ... and the member''s record counts again: 1', 'service',
  format('select public.saas_member_record_count(%L, %L) = 1', t.f(), t.uid('r_author')));
select t.keep_catalog('forward again');
select t.same_catalog('[P2-1 c13] rolled forward again: the catalog is what it was before the rollbacks', 'applied', 'forward again');
select t.rows('[P2-1 c13] ... and the functions work: a role is changed', 'service',
  t.set_role(t.f(), t.uid('r_author'), 'Data Logger', t.uid('r_admin')), 1);

-- ---------------------------------------------------------------------------
-- Criterion 13: the schema is that of Phase 1
-- ---------------------------------------------------------------------------

\i :rollback_drill_members
\i :rollback_saas_members

select t.keep_catalog('rolled back twice');
select t.same_catalog('[P2-1 c13] the rollbacks leave the same catalog the second time as the first', 'rolled back', 'rolled back twice');

-- Phase 1 afresh: its own rollbacks, then its two migrations. (This drops the
-- foundation's rows; it is the last thing the file does.)
\i :rollback_drill
\i :rollback_core
\i :mig_core
\i :mig_drill

select t.keep_catalog('phase 1 afresh');
select t.same_catalog('[P2-1 c13] after both member rollbacks the catalog is exactly that of the Phase 1 migrations applied afresh: tables, columns, constraints, indexes, policies, functions (bodies and grants), triggers, privileges',
  'rolled back', 'phase 1 afresh');

rollback;
select 'done';
