-- Criterion 10 for profiles, and the cross-organization cases of criterion 12:
-- a profile is readable by its owner, or by someone who shares an organization
-- with the owner and is Supervisor or Administrator there.
-- plan: 57
begin;
\ir ../lib/helpers.sql
\ir ../lib/fixture.sql

create table t.profile_cases (actor text, target text, yes boolean, why text);
insert into t.profile_cases values
  ('a_driller', 'a_driller',  true,  'their own'),
  ('a_gone',    'a_gone',     true,  'their own (deactivated member)'),
  ('stranger',  'stranger',   true,  'their own (no membership)'),
  ('padmin',    'padmin',     true,  'their own (platform administrator)'),
  ('a_super',   'a_driller',  true,  'Supervisor of the organization they share'),
  ('a_admin',   'a_driller',  true,  'Administrator of the organization they share'),
  ('a_super',   'dual',       true,  'Supervisor of A; the owner is also in B'),
  ('b_super',   'dual',       true,  'Supervisor of B; the owner is also in A'),
  ('dual',      'b_driller',  true,  'Supervisor in B, where the owner is'),
  -- Criterion 19: names on old records still resolve.
  ('a_super',   'a_gone',     true,  'c19: Supervisor; the owner is a deactivated member of their organization'),
  ('a_admin',   'a_gone',     true,  'c19: Administrator; the owner is a deactivated member of their organization'),
  ('a_admin',   'a_exsuper',  true,  'c19: Administrator; the owner is a deactivated Supervisor of their organization'),
  ('a_admin',   'mixed',      true,  'c19: Administrator of A, where the owner is deactivated'),
  ('b_super',   'mixed',      true,  'Supervisor of B, where the owner is active'),
  ('b_admin',   'a_gone',     false, 'c19 is per organization: Administrator of another one'),
  ('a_driller', 'a_gone',     false, 'c19 is for reviewers: a Driller'),
  ('a_driller', 'a_super',    false, 'a Driller is not a reviewer'),
  ('a_driller', 'a_driller2', false, 'a Driller is not a reviewer'),
  ('a_logger',  'a_driller',  false, 'a Data Logger is not a reviewer'),
  ('dual',      'a_driller',  false, 'shares A with the owner, but is only a Driller there'),
  ('a_super',   'b_driller',  false, 'Supervisor of another organization'),
  ('a_admin',   'b_driller',  false, 'Administrator of another organization'),
  ('a_admin',   'b_admin',    false, 'Administrator of another organization'),
  ('b_admin',   'a_driller',  false, 'Administrator of another organization'),
  ('b_super',   'a_super',    false, 'Supervisor of another organization'),
  ('a_super',   'stranger',   false, 'the owner belongs to no organization'),
  ('a_admin',   'stranger',   false, 'the owner belongs to no organization'),
  ('a_admin',   'padmin',     false, 'the owner belongs to no organization'),
  ('padmin',    'a_driller',  false, 'a platform administrator is not a member'),
  ('stranger',  'a_driller',  false, 'legacy profiles.role says Administrator, but no membership'),
  ('a_exsuper', 'a_driller',  false, 'a deactivated Supervisor'),
  ('a_exadmin', 'a_driller',  false, 'a deactivated Administrator'),
  ('a_invited', 'a_driller',  false, 'an invited, not yet active Supervisor'),
  ('mixed',     'a_driller',  false, 'deactivated Administrator of A'),
  ('mixed',     'b_driller',  false, 'only a Driller in B'),
  ('anon',      'a_driller',  false, 'signed out');

select case when yes
  then t.rows(format('[c10] profiles: %s reads the profile of %s (%s)', actor, target, why), actor,
              format('select id from public.profiles where id = %L', t.uid(target)), 1)
  else t.none(format('[c10][c12] profiles: %s cannot read the profile of %s (%s)', actor, target, why), actor,
              format('select id from public.profiles where id = %L', t.uid(target)))
  end
from t.profile_cases order by yes desc, actor, target;

select t.none(format('[c12] profiles: listing as %s returns nobody from outside their organization', actor), actor,
  format('select id from public.profiles where id in (%s)', ids))
from (values
  ('a_admin', format('%L, %L, %L, %L, %L', t.uid('b_driller'), t.uid('b_super'), t.uid('b_admin'), t.uid('stranger'), t.uid('padmin'))),
  ('a_super', format('%L, %L, %L, %L, %L', t.uid('b_driller'), t.uid('b_super'), t.uid('b_admin'), t.uid('stranger'), t.uid('padmin'))),
  ('b_admin', format('%L, %L, %L, %L, %L', t.uid('a_driller'), t.uid('a_super'), t.uid('a_admin'), t.uid('stranger'), t.uid('padmin')))
) v(actor, ids);
select t.rows('[c10] profiles: a Driller listing profiles gets their own and no other', 'a_driller',
  'select id from public.profiles', 1);
select t.none('[c10] profiles: a signed-out client lists none', 'anon', 'select id from public.profiles');

-- Writes.
select t.rows('[c10] profiles: a user changes their own name', 'a_driller',
  format('update public.profiles set name = ''New'' where id = %L', t.uid('a_driller')), 1);
select t.throws(format('[c10] profiles: %s cannot change their own profiles.role', actor), actor,
  format('update public.profiles set role = ''Administrator'' where id = %L', t.uid(actor)), '42501')
from (values ('a_driller'), ('a_super'), ('a_admin'), ('stranger')) v(actor);
select t.none(format('[c10][c12] profiles: %s cannot change the profile of %s', actor, target), actor,
  format('update public.profiles set name = ''Defaced'' where id = %L', t.uid(target)))
from (values ('a_admin', 'a_driller'), ('a_super', 'a_driller'), ('a_admin', 'b_driller'), ('b_admin', 'a_admin'), ('a_driller', 'a_driller2')) v(actor, target);
select t.throws(format('[c10][c12] profiles: %s cannot set the role on the profile of %s', actor, target), actor,
  format('update public.profiles set role = ''Administrator'' where id = %L', t.uid(target)), '42501')
from (values ('a_admin', 'a_driller'), ('a_admin', 'b_driller')) v(actor, target);
select t.throws('[c10] profiles: a user cannot insert a profile', 'a_driller',
  format('insert into public.profiles (id, name) values (%L, ''x'')', t.uid('no such user')), '42501');
select t.throws(format('[c10] profiles: %s cannot delete a profile', actor), actor,
  format('delete from public.profiles where id = %L', t.uid('a_driller')), '42501')
from (values ('a_driller'), ('a_admin')) v(actor);

rollback;
select 'done';
