-- The foundation on its own: a database with the Supabase stand-in and
-- saas_core, and nothing of Drill's (criterion A: reusable; criterion 2:
-- the default administering role is 'admin'). Run by supabase/tests/local.sh
-- only; CI's database always has the Drill migrations too.
-- plan: 9
begin;
\ir ../lib/helpers.sql

select t.ok('[c2] with the foundation alone, saas_admin_roles() returns {admin}',
  $$ select public.saas_admin_roles() = array['admin'] $$);

insert into public.organizations (id, name) values (t.uid('org_a'), 'Org A'), (t.uid('org_b'), 'Org B');
insert into auth.users (id, email)
  select t.uid(a), a || '@db-test.invalid' from unnest(array['c_admin', 'c_member', 'c_other']) a;

select t.did('[A] the foundation accepts any role name: it has no vocabulary of its own', null,
  format('insert into public.memberships (org_id, user_id, role) values (%L, %L, ''admin''), (%L, %L, ''surveyor''), (%L, %L, ''admin'')',
         t.uid('org_a'), t.uid('c_admin'), t.uid('org_a'), t.uid('c_member'), t.uid('org_b'), t.uid('c_other')), 3);

select t.rows('[c2] is_org_admin() is true for a member whose role is in saas_admin_roles()', 'c_admin',
  format('select 1 where public.is_org_admin(%L)', t.uid('org_a')), 1);
select t.none('[c2] is_org_admin() is not true for another role', 'c_member',
  format('select 1 where public.is_org_admin(%L)', t.uid('org_a')));
select t.none('[c2] is_org_admin() is not true for the admin of another organization', 'c_other',
  format('select 1 where public.is_org_admin(%L)', t.uid('org_a')));
select t.rows('[c3] an organization admin reads every membership of the organization', 'c_admin',
  'select user_id from public.memberships', 2);
select t.rows('[c3] a member reads their own membership only', 'c_member',
  'select user_id from public.memberships', 1);
select t.rows('[c3] a member reads their own organization only', 'c_member',
  'select id from public.organizations', 1);
select t.none('[c3] the admin of another organization reads none of this one''s memberships', 'c_other',
  format('select user_id from public.memberships where org_id = %L', t.uid('org_a')));

rollback;
select 'done';
