-- SaaS Phase 2, task P2-1, section A: saas_members on its own.
--
-- A database with the Supabase stand-in, saas_core and saas_members, and
-- nothing of Drill's: no profiles, no record tables, no Drill roles. The
-- member functions must work here with the foundation's own vocabulary
-- (criterion 1: {admin,member}; Phase 1 criterion 2: saas_admin_roles() is
-- {admin}) and the foundation's record count (criterion 2: 0).
-- Run by supabase/tests/local.sh only; CI's database always has the Drill
-- migrations too (there, 95_members_rollback.sql looks at the defaults).
-- plan: 40
begin;
\ir ../lib/helpers.sql
\ir ../sql/inc/members.sql

create function t.a() returns uuid language sql immutable as $$ select t.uid('org_a') $$;
create function t.b() returns uuid language sql immutable as $$ select t.uid('org_b') $$;

insert into public.organizations (id, name) values (t.a(), 'Org A'), (t.b(), 'Org B');
insert into auth.users (id, email)
  select t.uid(x), x || '@db-test.invalid'
  from unnest(array['c_admin', 'c_admin2', 'c_member', 'c_new', 'c_invited', 'c_other']) x;
insert into public.memberships (org_id, user_id, role, status) values
  (t.a(), t.uid('c_admin'),   'admin',  'active'),
  (t.a(), t.uid('c_member'),  'member', 'active'),
  (t.a(), t.uid('c_invited'), 'member', 'invited'),
  (t.b(), t.uid('c_other'),   'admin',  'active');

select t.ok('[P2-1 c1] with the foundation alone, saas_roles() returns exactly {admin,member}', 'service',
  $$ select public.saas_roles() = array['admin', 'member'] $$);
select t.ok('[P2-1 c1] ... to a signed-in user too', 'c_member',
  $$ select public.saas_roles() = array['admin', 'member'] $$);
select t.throws('[P2-1 c1] ... and not to a signed-out client: 42501', 'anon',
  $$ select public.saas_roles() $$, '42501');
select t.ok('[P2-1 c2] with the foundation alone, saas_member_record_count() is 0', 'service',
  format('select public.saas_member_record_count(%L, %L) = 0', t.a(), t.uid('c_member')));
select t.throws('[P2-1 c2] ... and a signed-in user cannot call it: 42501', 'c_admin',
  format('select public.saas_member_record_count(%L, %L)', t.a(), t.uid('c_member')), '42501');

-- saas_add_member
select t.mark_audit();
select t.did('[P2-1 c3] foundation alone: a member is added with the role "member"', 'service',
  t.add(t.a(), t.uid('c_new'), 'member', 'N-1', 'active', t.uid('c_admin')), 1);
select t.ok('[P2-1 c3] ... the membership is there',
  $$ select t.m('c_new') = 'member/active/N-1' $$);
select t.audited('[P2-1 c3] ... one audit row', t.uid('c_admin'), t.a(), t.uid('c_new'));
select t.rows('[P2-1 c3] foundation alone: the role "admin" is accepted', 'service',
  t.add(t.a(), t.uid('c_other'), 'admin', null, 'invited', t.uid('c_admin')), 1);
select t.refused(format('[P2-1 c3][P2-1 A] foundation alone: the role "%s" is refused: it is not in saas_roles() (the table itself would take it)', r), 'service',
  t.add(t.a(), t.uid('c_other'), r, null, 'active', t.uid('c_admin')), 'add', null)
from (values ('Driller'), ('Administrator'), ('surveyor'), ('Admin')) v(r);
select t.refused('[P2-1 c3] foundation alone: adding somebody who is already a member is refused', 'service',
  t.add(t.a(), t.uid('c_member'), 'member', null, 'active', t.uid('c_admin')), 'add', null);
select t.throws('[P2-1 c3] foundation alone: a signed-in administrator cannot call saas_add_member: 42501', 'c_admin',
  t.add(t.a(), t.uid('c_other'), 'member', null, 'active', t.uid('c_admin')), '42501');

-- saas_set_member_role and the last-administrator rule, on saas_admin_roles() = {admin}
select t.refused('[P2-1 c3] foundation alone: demoting the only active admin is refused', 'service',
  t.set_role(t.a(), t.uid('c_admin'), 'member', t.uid('c_member')), 'role', 'last administrator');
select t.refused('[P2-1 c3] foundation alone: changing one''s own role is refused', 'service',
  t.set_role(t.a(), t.uid('c_member'), 'admin', t.uid('c_member')), 'role', 'self');
select t.refused('[P2-1 c3] foundation alone: a role outside saas_roles() is refused', 'service',
  t.set_role(t.a(), t.uid('c_member'), 'Supervisor', t.uid('c_admin')), 'role', 'role');
select t.refused('[P2-1 c3][P2-1 c12] foundation alone: a user with no membership in the organization is refused', 'service',
  t.set_role(t.a(), t.uid('c_other'), 'member', t.uid('c_admin')), 'role', 'no membership');
select t.distinguishable('[P2-1 c3] foundation alone: those four refusals can be told apart', 'role', 4);
select t.did('[P2-1 c3] foundation alone: a member is promoted to admin', 'service',
  t.set_role(t.a(), t.uid('c_new'), 'admin', t.uid('c_admin')), 1);
select t.rows('[P2-1 c3] ... and with two active admins one can be demoted', 'service',
  t.set_role(t.a(), t.uid('c_admin'), 'member', t.uid('c_new')), 1);

-- badge and status
select t.did('[P2-1 c3] foundation alone: a badge is set', 'service',
  t.set_badge(t.a(), t.uid('c_member'), 'M-1', t.uid('c_admin')), 1);
select t.did('[P2-1 c3] foundation alone: a member is deactivated', 'service',
  t.set_status(t.a(), t.uid('c_member'), 'deactivated', t.uid('c_admin')), 1);
select t.ok('[P2-1 c3] ... both are on the membership',
  $$ select t.m('c_member') = 'member/deactivated/M-1' $$);
select t.none('[P2-1 c3] ... and the deactivated member is no member any more', 'c_member',
  format('select 1 where public.is_org_member(%L)', t.a()));
select t.refused('[P2-1 c3] foundation alone: an invited membership cannot be activated by somebody else', 'service',
  t.set_status(t.a(), t.uid('c_invited'), 'active', t.uid('c_admin')), 'status', 'invited');
select t.did('[P2-1 c3] foundation alone: with two active admins one is deactivated', 'service',
  t.set_status(t.a(), t.uid('c_new'), 'deactivated', t.uid('c_admin')), 1);
select t.refused('[P2-1 c3] foundation alone: deactivating the only active admin left is refused', 'service',
  t.set_status(t.a(), t.uid('c_admin'), 'deactivated', t.uid('c_member')), 'status', 'last administrator');

-- remove: the default record count is 0, so a removal always deletes
select t.ok('[P2-1 c3][P2-1 c2] foundation alone: saas_remove_member returns ''removed''', 'service',
  format('select public.saas_remove_member(%L, %L, %L) = ''removed''', t.a(), t.uid('c_member'), t.uid('c_admin')));
select t.did('[P2-1 c3] ... done', 'service',
  t.remove(t.a(), t.uid('c_member'), t.uid('c_admin')), 1);
select t.ok('[P2-1 c3] ... the membership is gone and the account is still there',
  $$ select t.m('c_member') = 'no membership' and (select count(*) = 1 from auth.users where id = t.uid('c_member')) $$);
select t.refused('[P2-1 c3] foundation alone: removing the only active admin is refused', 'service',
  t.remove(t.a(), t.uid('c_admin'), t.uid('c_new')), 'remove', 'last administrator');
select t.refused('[P2-1 c3] foundation alone: removing oneself is refused', 'service',
  t.remove(t.a(), t.uid('c_invited'), t.uid('c_invited')), 'remove', 'self');

-- invitations
select t.throws('[P2-1 c5] foundation alone: accept_membership raises 42501 for somebody with no invitation there', 'c_other',
  format('select public.accept_membership(%L)', t.a()), '42501');
select t.mark_audit();
select t.did('[P2-1 c5] foundation alone: the invited person accepts', 'c_invited',
  format('select public.accept_membership(%L)', t.a()), 1);
select t.ok('[P2-1 c5] ... and is an active member',
  $$ select t.m('c_invited') = 'member/active/-' $$);
select t.audited_own('[P2-1 c5] ... one audit row, with the caller as actor', t.uid('c_invited'), t.a());
select t.throws('[P2-1 c5] foundation alone: decline_membership raises 42501 once there is no invitation', 'c_invited',
  format('select public.decline_membership(%L)', t.a()), '42501');

select t.ok('[P2-1 c12] foundation alone: nothing above touched the other organization',
  $$ select t.m('c_other') = 'admin/active/-' $$);

rollback;
select 'done';
