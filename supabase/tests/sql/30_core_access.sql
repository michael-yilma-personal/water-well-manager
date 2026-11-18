-- Foundation behaviour: the helper functions (criterion 2), the read policies
-- (criterion 3), the role vocabulary (criterion 5), and the cross-organization
-- cases of criterion 12 for memberships, organizations, platform_admins and
-- audit_log.
-- plan: 202
begin;
\ir ../lib/helpers.sql
\ir ../lib/fixture.sql

-- ---------------------------------------------------------------------------
-- Criterion 2: what the functions answer, per caller
-- ---------------------------------------------------------------------------

-- `yes` true: the expression is true for the caller. false: it is false, or
-- the caller may not even call it.
create table t.fn_cases (actor text, expr text, yes boolean, why text);
insert into t.fn_cases values
  ('a_driller', $$public.is_org_member(t.uid('org_a'))$$, true,  'an active member'),
  ('a_driller', $$public.is_org_member(t.uid('org_b'))$$, false, 'a member of another organization'),
  ('a_gone',    $$public.is_org_member(t.uid('org_a'))$$, false, 'a deactivated member'),
  ('a_invited', $$public.is_org_member(t.uid('org_a'))$$, false, 'an invited, not yet active member'),
  ('dual',      $$public.is_org_member(t.uid('org_a'))$$, true,  'a member of both, first organization'),
  ('dual',      $$public.is_org_member(t.uid('org_b'))$$, true,  'a member of both, second organization'),
  ('mixed',     $$public.is_org_member(t.uid('org_a'))$$, false, 'deactivated here, active elsewhere'),
  ('mixed',     $$public.is_org_member(t.uid('org_b'))$$, true,  'active here, deactivated elsewhere'),
  ('stranger',  $$public.is_org_member(t.uid('org_a'))$$, false, 'an account with no membership'),
  ('padmin',    $$public.is_org_member(t.uid('org_a'))$$, false, 'a platform administrator with no membership'),
  ('anon',      $$public.is_org_member(t.uid('org_a'))$$, false, 'a signed-out client'),
  ('a_driller', $$public.is_org_member(null)$$,           false, 'a null organization'),

  ('a_driller', $$public.has_org_role(t.uid('org_a'), 'Driller')$$,                     true,  'the role held'),
  ('a_driller', $$public.has_org_role(t.uid('org_a'), 'Supervisor', 'Driller')$$,       true,  'one of several roles'),
  ('a_driller', $$public.has_org_role(t.uid('org_a'), 'Supervisor', 'Administrator')$$, false, 'roles not held'),
  ('a_driller', $$public.has_org_role(t.uid('org_a'), 'driller')$$,                     false, 'the role in the wrong case'),
  ('a_driller', $$public.has_org_role(t.uid('org_b'), 'Driller')$$,                     false, 'the role held, but in another organization'),
  ('a_driller', $$public.has_org_role(t.uid('org_a'), variadic array[]::text[])$$,      false, 'an empty role list'),
  ('a_gone',    $$public.has_org_role(t.uid('org_a'), 'Driller')$$,                     false, 'a deactivated member'),
  ('a_invited', $$public.has_org_role(t.uid('org_a'), 'Supervisor')$$,                  false, 'an invited member'),
  ('dual',      $$public.has_org_role(t.uid('org_a'), 'Driller')$$,                     true,  'Driller in A'),
  ('dual',      $$public.has_org_role(t.uid('org_b'), 'Supervisor')$$,                  true,  'Supervisor in B'),
  ('dual',      $$public.has_org_role(t.uid('org_a'), 'Supervisor')$$,                  false, 'the role held in B asked of A'),
  ('dual',      $$public.has_org_role(t.uid('org_b'), 'Driller')$$,                     false, 'the role held in A asked of B'),
  ('dual',      $$public.has_org_role(t.uid('org_a'), 'Administrator')$$,               false, 'a legacy profiles.role of Administrator'),
  ('mixed',     $$public.has_org_role(t.uid('org_a'), 'Administrator')$$,               false, 'a deactivated Administrator'),
  ('anon',      $$public.has_org_role(t.uid('org_a'), 'Driller')$$,                     false, 'a signed-out client'),

  ('a_admin',   $$public.is_org_admin(t.uid('org_a'))$$, true,  'the Administrator'),
  ('a_admin',   $$public.is_org_admin(t.uid('org_b'))$$, false, 'the Administrator of another organization'),
  ('b_admin',   $$public.is_org_admin(t.uid('org_a'))$$, false, 'the Administrator of another organization (other direction)'),
  ('a_super',   $$public.is_org_admin(t.uid('org_a'))$$, false, 'a Supervisor'),
  ('a_driller', $$public.is_org_admin(t.uid('org_a'))$$, false, 'a Driller'),
  ('a_exadmin', $$public.is_org_admin(t.uid('org_a'))$$, false, 'a deactivated Administrator'),
  ('mixed',     $$public.is_org_admin(t.uid('org_a'))$$, false, 'a deactivated Administrator active elsewhere'),
  ('dual',      $$public.is_org_admin(t.uid('org_b'))$$, false, 'a Supervisor whose legacy profile says Administrator'),
  ('stranger',  $$public.is_org_admin(t.uid('org_a'))$$, false, 'a legacy profiles.role of Administrator and no membership'),
  ('padmin',    $$public.is_org_admin(t.uid('org_a'))$$, false, 'a platform administrator'),
  ('anon',      $$public.is_org_admin(t.uid('org_a'))$$, false, 'a signed-out client'),

  ('padmin',    $$public.is_platform_admin()$$, true,  'a platform administrator'),
  ('a_admin',   $$public.is_platform_admin()$$, false, 'an organization Administrator'),
  ('a_driller', $$public.is_platform_admin()$$, false, 'a Driller'),
  ('stranger',  $$public.is_platform_admin()$$, false, 'a legacy profiles.role of Administrator'),
  ('anon',      $$public.is_platform_admin()$$, false, 'a signed-out client');

select case when yes
  then t.rows(format('[c2] %s is true for %s (%s)', expr, actor, why), actor, format('select 1 where %s', expr), 1)
  else t.none(format('[c2] %s is not true for %s (%s)', expr, actor, why), actor, format('select 1 where %s', expr))
  end
from t.fn_cases order by expr, actor;

select t.ok('[c2] my_organizations(): a member of one organization gets one row: org_id, name, role, status', 'a_driller',
  $$ select count(*) = 1 and bool_and(org_id = t.uid('org_a') and name = 'Org A' and role = 'Driller' and status = 'active')
     from public.my_organizations() $$);
select t.ok('[c2] my_organizations(): a member of two gets two rows, each with its own role', 'dual',
  $$ select count(*) = 2
        and count(*) filter (where org_id = t.uid('org_a') and name = 'Org A' and role = 'Driller' and status = 'active') = 1
        and count(*) filter (where org_id = t.uid('org_b') and name = 'Org B' and role = 'Supervisor' and status = 'active') = 1
     from public.my_organizations() $$);
select t.ok('[c2] my_organizations(): one row per membership includes a deactivated one, marked as such', 'mixed',
  $$ select count(*) = 2
        and count(*) filter (where org_id = t.uid('org_a') and status = 'deactivated') = 1
        and count(*) filter (where org_id = t.uid('org_b') and status = 'active') = 1
     from public.my_organizations() $$);
select t.ok('[c18] my_organizations(): a member whose only membership is deactivated still gets that row, with its status', 'a_gone',
  $$ select count(*) = 1 and bool_and(org_id = t.uid('org_a') and name = 'Org A' and role = 'Driller' and status = 'deactivated')
     from public.my_organizations() $$);
select t.none('[c2] my_organizations(): nothing for an account with no membership', 'stranger',
  $$ select * from public.my_organizations() $$);
select t.none('[c2] my_organizations(): nothing for a platform administrator with no membership', 'padmin',
  $$ select * from public.my_organizations() $$);
select t.none('[c2] my_organizations(): nothing for a signed-out client', 'anon',
  $$ select * from public.my_organizations() $$);

-- ---------------------------------------------------------------------------
-- Criterion 5 (and the status check of criterion 1): what a membership may hold
-- ---------------------------------------------------------------------------

select t.rows(format('[c5] a membership with role "%s" is accepted', r), null,
  format('insert into public.memberships (org_id, user_id, role) values (%L, %L, %L)', t.uid('org_a'), t.uid('stranger'), r), 1)
from (values ('Driller'), ('Data Logger'), ('Supervisor'), ('Administrator')) v(r);
select t.throws(format('[c5] a membership with role "%s" is rejected', r), null,
  format('insert into public.memberships (org_id, user_id, role) values (%L, %L, %L)', t.uid('org_a'), t.uid('stranger'), r), '23514')
from (values ('admin'), ('driller'), ('Owner'), ('')) v(r);
select t.throws('[c5] an existing membership cannot be changed to a role outside the vocabulary', null,
  format('update public.memberships set role = ''admin'' where org_id = %L and user_id = %L', t.uid('org_a'), t.uid('a_admin')), '23514');
select t.rows(format('[c1] a membership with status "%s" is accepted', s), null,
  format('insert into public.memberships (org_id, user_id, role, status) values (%L, %L, ''Driller'', %L)', t.uid('org_a'), t.uid('stranger'), s), 1)
from (values ('invited'), ('active'), ('deactivated')) v(s);
select t.throws(format('[c1] a membership with status "%s" is rejected', s), null,
  format('insert into public.memberships (org_id, user_id, role, status) values (%L, %L, ''Driller'', %L)', t.uid('org_a'), t.uid('stranger'), s), '23514')
from (values ('banned'), ('Active'), ('')) v(s);
select t.ok('[c1] a membership created without a status is active', null,
  format('with i as (insert into public.memberships (org_id, user_id, role) values (%L, %L, ''Driller'') returning status) select status = ''active'' from i',
         t.uid('org_a'), t.uid('stranger')));
select t.throws('[c1] one membership per user per organization', null,
  format('insert into public.memberships (org_id, user_id, role) values (%L, %L, ''Driller'')', t.uid('org_a'), t.uid('a_driller')), '23505');
select t.throws('[c1] a membership needs an existing organization', null,
  format('insert into public.memberships (org_id, user_id, role) values (%L, %L, ''Driller'')', t.uid('no such org'), t.uid('stranger')), '23503');
select t.throws('[c1] a membership needs an existing account', null,
  format('insert into public.memberships (org_id, user_id, role) values (%L, %L, ''Driller'')', t.uid('org_a'), t.uid('no such user')), '23503');

-- ---------------------------------------------------------------------------
-- Criterion 3 / 12: organizations
-- ---------------------------------------------------------------------------

select t.ok(format('[c3] organizations: %s reads exactly %s', actor, what), actor,
  format('select count(*) = %s and coalesce(bool_and(id in (%s)), true) from public.organizations', n, ids))
from (values
  ('a_driller', 'their own organization', 1, format('%L', t.uid('org_a'))),
  ('a_admin',   'their own organization', 1, format('%L', t.uid('org_a'))),
  ('b_admin',   'their own organization', 1, format('%L', t.uid('org_b'))),
  ('dual',      'both of theirs',         2, format('%L, %L', t.uid('org_a'), t.uid('org_b')))
) v(actor, what, n, ids);
select t.none(format('[c3][c12] organizations: %s cannot read the other organization by id', actor), actor,
  format('select name from public.organizations where id = %L', t.uid(org)))
from (values ('a_driller', 'org_b'), ('a_super', 'org_b'), ('a_admin', 'org_b'), ('b_admin', 'org_a'), ('b_driller', 'org_a')) v(actor, org);
select t.none(format('[c3] organizations: %s reads none', actor), actor, 'select * from public.organizations')
from (values ('stranger'), ('anon')) v(actor);
select t.none(format('[c18] organizations: %s, deactivated, reads no organization row, not even their former one', actor), actor,
  'select * from public.organizations')
from (values ('a_gone'), ('a_exsuper'), ('a_exadmin')) v(actor);
select t.ok('[c18] organizations: deactivated in A and active in B reads B only', 'mixed',
  format('select count(*) = 1 and bool_and(id = %L) from public.organizations', t.uid('org_b')));
select t.rows('[c3] organizations: a platform administrator reads every organization', 'padmin',
  'select id from public.organizations', (select count(*) from public.organizations));

select t.throws(format('[c1][c12] organizations: %s cannot %s', actor, op), actor, q, '42501')
from (values ('a_driller'), ('a_admin'), ('padmin'), ('stranger'), ('anon')) a(actor),
     (values
       ('create one',            $$insert into public.organizations (name) values ('Mine')$$),
       ('rename one',            $$update public.organizations set name = 'Renamed'$$),
       ('delete one',            $$delete from public.organizations$$)) o(op, q)
order by actor, op;

-- ---------------------------------------------------------------------------
-- Criterion 3 / 12: memberships
-- ---------------------------------------------------------------------------

select t.ok(format('[c3] memberships: %s reads %s row(s): %s', actor, n, what), actor,
  format('select count(*) = %s and coalesce(bool_and(%s), true) from public.memberships', n, cond))
from (values
  ('a_driller', 1,  'their own',                               'user_id = auth.uid()'),
  ('a_super',   1,  'their own (a Supervisor is not an admin)', 'user_id = auth.uid()'),
  ('a_admin',   11, 'every membership of their organization',  format('org_id = %L', t.uid('org_a'))),
  ('b_admin',   5,  'every membership of their organization',  format('org_id = %L', t.uid('org_b'))),
  ('dual',      2,  'their own two',                           'user_id = auth.uid()')
) v(actor, n, what, cond);
select t.none(format('[c3][c12] memberships: %s cannot read %s', actor, what), actor,
  format('select * from public.memberships where %s', cond))
from (values
  ('a_admin',   'the other organization''s memberships',                 format('org_id = %L', t.uid('org_b'))),
  ('a_admin',   'a shared user''s membership in the other organization', format('user_id = %L and org_id <> %L', t.uid('dual'), t.uid('org_a'))),
  ('b_admin',   'the other organization''s memberships',                 format('org_id = %L', t.uid('org_a'))),
  ('a_driller', 'anyone else''s membership',                             'user_id <> auth.uid()'),
  ('a_super',   'anyone else''s membership',                             'user_id <> auth.uid()'),
  ('dual',      'anyone else''s membership',                             'user_id <> auth.uid()'),
  ('a_exadmin', 'anyone else''s membership (deactivated Administrator)', 'user_id <> auth.uid()'),
  ('mixed',     'anyone else''s membership (deactivated Administrator, active Driller elsewhere)', 'user_id <> auth.uid()'),
  ('a_gone',    'anyone else''s membership (deactivated)',               'user_id <> auth.uid()'),
  ('a_invited', 'anyone else''s membership (invited)',                   'user_id <> auth.uid()'),
  ('stranger',  'any membership',                                        'true'),
  ('anon',      'any membership',                                        'true')
) v(actor, what, cond);
select t.none(format('[c18] memberships: %s, deactivated, reads no membership row, their own included', actor), actor,
  'select * from public.memberships')
from (values ('a_gone'), ('a_exsuper'), ('a_exadmin')) v(actor);
select t.ok('[c18] memberships: deactivated in A and active in B reads their B row and not their deactivated A row', 'mixed',
  format('select count(*) = 1 and bool_and(org_id = %L and user_id = auth.uid()) from public.memberships', t.uid('org_b')));
select t.rows('[c3] memberships: a platform administrator reads every membership', 'padmin',
  'select user_id from public.memberships', (select count(*) from public.memberships));

select t.throws(format('[c1][c12] memberships: %s cannot %s', actor, op), actor, format(q, t.uid(actor)), '42501')
from (values ('a_driller'), ('a_super'), ('a_admin'), ('a_gone'), ('dual'), ('padmin'), ('stranger'), ('anon')) a(actor),
     (values
       ('join the other organization as Administrator',
          format('insert into public.memberships (org_id, user_id, role) values (%L, %%L, ''Administrator'')', t.uid('org_b'))),
       ('promote themselves',     'update public.memberships set role = ''Administrator'' where user_id = %L'),
       ('reactivate a membership', 'update public.memberships set status = ''active'' where user_id = %L or true'),
       ('remove a membership',     'delete from public.memberships where user_id = %L or true')) o(op, q)
order by actor, op;

-- ---------------------------------------------------------------------------
-- Criterion 3: platform_admins
-- ---------------------------------------------------------------------------

select t.rows('[c3] platform_admins: a platform administrator reads the list', 'padmin',
  'select user_id from public.platform_admins', (select count(*) from public.platform_admins));
select t.none(format('[c3] platform_admins: %s reads nothing', actor), actor, 'select * from public.platform_admins')
from (values ('a_admin'), ('b_admin'), ('a_super'), ('a_driller'), ('dual'), ('stranger'), ('anon')) v(actor);
select t.throws(format('[c1] platform_admins: %s cannot %s', actor, op), actor, format(q, t.uid(actor)), '42501')
from (values ('a_driller'), ('a_admin'), ('padmin'), ('stranger'), ('anon')) a(actor),
     (values
       ('add themselves', 'insert into public.platform_admins (user_id) values (%L)'),
       ('change a row',   'update public.platform_admins set user_id = %L'),
       ('remove a row',   'delete from public.platform_admins where user_id <> %L')) o(op, q)
order by actor, op;

-- ---------------------------------------------------------------------------
-- Criterion 3 / 12: audit_log
-- ---------------------------------------------------------------------------

select t.rows('[c3] audit_log: a platform administrator reads every row, with or without an organization', 'padmin',
  $$ select id from public.audit_log where action like 'test.%' $$, 3);
select t.ok(format('[c3][c12] audit_log: %s reads the rows of their own organization and no other', actor), actor,
  format($$ select count(*) = 1 and bool_and(action = %L) from public.audit_log $$, action))
from (values ('a_admin', 'test.a'), ('b_admin', 'test.b')) v(actor, action);
select t.none(format('[c3] audit_log: %s reads nothing', actor), actor, 'select * from public.audit_log')
from (values ('a_super'), ('a_driller'), ('dual'), ('a_exadmin'), ('mixed'), ('stranger'), ('anon')) v(actor);
select t.throws(format('[c1] audit_log: %s cannot %s', actor, op), actor, q, '42501')
from (values ('a_driller'), ('a_admin'), ('padmin'), ('anon')) a(actor),
     (values
       ('write a row',  $$insert into public.audit_log (action) values ('forged')$$),
       ('change a row', $$update public.audit_log set action = 'rewritten'$$),
       ('delete a row', $$delete from public.audit_log$$)) o(op, q)
order by actor, op;

-- ---------------------------------------------------------------------------
-- Criterion 23: an account with a membership and no records can be deleted
-- ---------------------------------------------------------------------------

select t.did('[c23] deleting an account that has a membership and no records succeeds', null,
  format('delete from auth.users where id = %L', t.uid('a_invited')), 1);
select t.ok('[c23] ... and its membership and profile go with it',
  $$ select not exists (select 1 from public.memberships where user_id = t.uid('a_invited'))
        and not exists (select 1 from public.profiles where id = t.uid('a_invited')) $$);

rollback;
select 'done';
