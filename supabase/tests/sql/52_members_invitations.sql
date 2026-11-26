-- SaaS Phase 2, task P2-1, criterion 5 (with decision D2-1 and criterion 12):
-- accept_membership(org) and decline_membership(org).
--
-- Callable by a signed-in user, acting only on the caller's OWN invited
-- membership. With no invited membership of the caller in that organization
-- each raises 42501 and changes nothing. Each writes an audit row with the
-- caller as actor.
--
-- The invitations here are written directly, as the fixture writes every
-- membership, so this file does not depend on saas_add_member.
-- plan: 52
begin;
\ir ../lib/helpers.sql
\ir ../lib/fixture.sql
\ir inc/members.sql

create function t.a() returns uuid language sql immutable as $$ select t.uid('org_a') $$;
create function t.b() returns uuid language sql immutable as $$ select t.uid('org_b') $$;

-- a_invited  Supervisor, invited to org A (the fixture)
-- b_driller  active Driller in org B, invited to org A as Driller with a badge
-- stranger   invited to org A and to org B
insert into public.memberships (org_id, user_id, role, status, badge_number) values
  (t.a(), t.uid('b_driller'), 'Driller',     'invited', 'I-1'),
  (t.a(), t.uid('stranger'),  'Data Logger', 'invited', null),
  (t.b(), t.uid('stranger'),  'Driller',     'invited', null);

select t.ok('[P2-1 c5] setup: three accounts hold four invitations',
  $$ select t.mo('a_invited', t.a()) = 'Supervisor/invited/-' and t.mo('b_driller', t.a()) = 'Driller/invited/I-1'
        and t.mo('stranger', t.a()) = 'Data Logger/invited/-' and t.mo('stranger', t.b()) = 'Driller/invited/-' $$);

-- ---------------------------------------------------------------------------
-- Refusals: no invited membership of the caller in that organization
-- ---------------------------------------------------------------------------

create table t.cases (actor text, org uuid, why text);
insert into t.cases values
  ('a_gone',    t.a(), 'a DEACTIVATED member of that organization (it is not a way back in)'),
  ('mixed',     t.a(), 'a deactivated Administrator of that organization who is active elsewhere'),
  ('a_driller', t.a(), 'an ACTIVE member of that organization'),
  ('a_admin',   t.a(), 'the Administrator of the organization, where other people hold invitations'),
  ('b_admin',   t.a(), 'the Administrator of ANOTHER organization, where other people hold invitations'),
  ('a_invited', t.b(), 'somebody invited to a DIFFERENT organization'),
  ('padmin',    t.a(), 'a platform administrator with no membership'),
  ('a_invited', t.uid('no_such_org'), 'an invited person naming an organization that does not exist'),
  ('a_invited', null,  'an invited person naming no organization (null)');

select t.throws(format('[P2-1 c5] accept_membership raises 42501 for %s', why), actor,
  format('select public.accept_membership(%L)', org), '42501')
from t.cases order by why;
select t.throws(format('[P2-1 c5] decline_membership raises 42501 for %s', why), actor,
  format('select public.decline_membership(%L)', org), '42501')
from t.cases order by why;

select t.throws('[P2-1 c5] a signed-out client cannot call accept_membership: 42501', 'anon',
  format('select public.accept_membership(%L)', t.a()), '42501');
select t.throws('[P2-1 c5] a signed-out client cannot call decline_membership: 42501', 'anon',
  format('select public.decline_membership(%L)', t.a()), '42501');
-- With no signed-in user there is no "own" membership. Whether the service
-- role may call these at all is not specified; that nothing changes is.
select t.no_change('[P2-1 c5] accept_membership called with the service key (no user) changes nothing: other people''s invitations stay invitations', 'service',
  format('select public.accept_membership(%L)', t.a()));
select t.no_change('[P2-1 c5] decline_membership called with the service key (no user) changes nothing', 'service',
  format('select public.decline_membership(%L)', t.a()));

-- ---------------------------------------------------------------------------
-- D2-1: while it is only an invitation
-- ---------------------------------------------------------------------------

select t.ok('[P2-1 c5][D2-1] an invited account that works in another organization keeps working: a borehole sent without org_id lands in org B', 'b_driller',
  format('with i as (%s returning org_id) select org_id = %L from i',
         t.ins('boreholes', t.uid('new:1'), null, t.uid('b_driller')), t.b()));
select t.none('[P2-1 c5][D2-1] ... and reads nothing of the organization that invited them', 'b_driller',
  format('select id from public.boreholes where org_id = %L', t.a()));
select t.throws('[P2-1 c5][D2-1] ... and cannot write there: a borehole sent with that organization''s org_id is rejected', 'b_driller',
  t.ins('boreholes', t.uid('new:2'), null, t.uid('b_driller'), t.a()), '42501');

-- ---------------------------------------------------------------------------
-- accept_membership
-- ---------------------------------------------------------------------------

select t.mark_audit();
select t.did('[P2-1 c5] the invited Supervisor accepts their invitation to org A', 'a_invited',
  format('select public.accept_membership(%L)', t.a()), 1);
select t.ok('[P2-1 c5] ... the membership is active, with the role it was invited with',
  $$ select t.m('a_invited') = 'Supervisor/active/-' $$);
select t.audited_own('[P2-1 c5] ... one audit row, with the caller as actor, in that organization',
  t.uid('a_invited'), t.a());
select t.ok('[P2-1 c5] ... and nobody else''s invitation moved',
  $$ select t.mo('b_driller', t.a()) = 'Driller/invited/I-1' and t.mo('stranger', t.a()) = 'Data Logger/invited/-'
        and t.mo('stranger', t.b()) = 'Driller/invited/-' $$);
select t.rows('[P2-1 c5] ... the new Supervisor reads every borehole of org A', 'a_invited',
  format('select id from public.boreholes where org_id = %L', t.a()), 7);
select t.throws('[P2-1 c5] accepting a second time raises 42501', 'a_invited',
  format('select public.accept_membership(%L)', t.a()), '42501');
select t.throws('[P2-1 c5] declining after accepting raises 42501: an active membership is not left this way', 'a_invited',
  format('select public.decline_membership(%L)', t.a()), '42501');
select t.ok('[P2-1 c5] ... and the membership is still active',
  $$ select t.m('a_invited') = 'Supervisor/active/-' $$);

-- A second active membership, taken by the person themselves (D2-1).
select t.did('[P2-1 c5] the Driller of org B accepts their invitation to org A', 'b_driller',
  format('select public.accept_membership(%L)', t.a()), 1);
select t.ok('[P2-1 c5] ... active in org A with the invited role and badge; the membership in org B is as it was',
  $$ select t.mo('b_driller', t.a()) = 'Driller/active/I-1' and t.mo('b_driller', t.b()) = 'Driller/active/-' $$);
select t.audited_own('[P2-1 c5] ... one audit row, with the caller as actor, in org A',
  t.uid('b_driller'), t.a());
select t.rows('[P2-1 c5] ... they can now log a borehole in org A by naming it', 'b_driller',
  t.ins('boreholes', t.uid('new:3'), null, t.uid('b_driller'), t.a()), 1);
select t.throws('[P2-1 c5][c8] ... and, with two active memberships, a borehole sent without org_id is refused (42501), as Phase 1 says', 'b_driller',
  t.ins('boreholes', t.uid('new:4'), null, t.uid('b_driller')), '42501');

-- ---------------------------------------------------------------------------
-- decline_membership
-- ---------------------------------------------------------------------------

select t.mark_audit();
select t.did('[P2-1 c5] an account invited to two organizations declines org A', 'stranger',
  format('select public.decline_membership(%L)', t.a()), 1);
select t.ok('[P2-1 c5] ... the invitation to org A is deleted; the one to org B is still an invitation',
  $$ select t.mo('stranger', t.a()) = 'no membership' and t.m('stranger') = 'Driller/invited/-' $$);
select t.audited_own('[P2-1 c5] ... one audit row, with the caller as actor, in org A',
  t.uid('stranger'), t.a());
select t.ok('[P2-1 c5] ... the account itself is still there',
  $$ select count(*) = 1 from auth.users where id = t.uid('stranger') $$);
select t.throws('[P2-1 c5] declining a second time raises 42501', 'stranger',
  format('select public.decline_membership(%L)', t.a()), '42501');
select t.throws('[P2-1 c5] accepting what was declined raises 42501', 'stranger',
  format('select public.accept_membership(%L)', t.a()), '42501');

select t.mark_audit();
select t.did('[P2-1 c5] the same account accepts org B', 'stranger',
  format('select public.accept_membership(%L)', t.b()), 1);
select t.ok('[P2-1 c5] ... and is an active Driller of org B and of nothing else',
  $$ select t.m('stranger') = 'Driller/active/-' and t.mo('stranger', t.b()) = 'Driller/active/-' $$);
select t.audited_own('[P2-1 c5] ... one audit row, with the caller as actor, in org B',
  t.uid('stranger'), t.b());

-- ---------------------------------------------------------------------------
-- Criterion 12: who reads those audit rows
-- ---------------------------------------------------------------------------

select t.ok('[P2-1 c12] the Administrator of org A reads the audit rows of the invitations answered in org A (three), and no row of org B', 'a_admin',
  format($$ select count(*) filter (where actor_id in (%L, %L, %L)) = 3 and bool_and(org_id = %L) from public.audit_log $$,
         t.uid('a_invited'), t.uid('b_driller'), t.uid('stranger'), t.a()));
select t.ok('[P2-1 c12] the Administrator of org B reads the one answered in org B, and no row of org A', 'b_admin',
  format($$ select count(*) filter (where actor_id = %L) = 1 and bool_and(org_id = %L) from public.audit_log $$,
         t.uid('stranger'), t.b()));
select t.none('[P2-1 c12] the person who accepted reads no audit row (a Supervisor is not an administrator)', 'a_invited',
  $$ select id from public.audit_log $$);

rollback;
select 'done';
