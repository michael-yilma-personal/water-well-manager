-- Decisions 26-31, the cases the first round of tests left open. Added in the
-- validation after the ninth review's fix: each check here failed against a
-- scratch copy of the Drill migration with one guard removed or inverted, and
-- nothing else in the suite did.
--
-- Unlike 25_mirroring.sql, some checks here name how the migration marks the
-- founding organization (organizations.is_founding, founding_org_id()) and a
-- ban-deactivated membership (memberships.deactivated_by_ban): the guards
-- under test cannot be reached otherwise. Those checks say so in their names.
-- plan: 38
begin;
\ir ../lib/helpers.sql

create table t.founding as select id from public.organizations;
grant select on t.founding to public;

create function t.f() returns uuid
language sql stable
as $$ select id from t.founding $$;

-- Every membership of the account.
create function t.m(actor text) returns text
language sql stable
as $$
  select coalesce(string_agg(format('%s/%s/%s', role, status, coalesce(badge_number, '-')), ' + ' order by org_id), 'no membership')
  from public.memberships where user_id = t.uid(actor)
$$;

-- What a refused statement looked like to the client: SQLSTATE and message.
create function t.refusal(actor text, q text) returns text
language sql
as $$ select r.state || ' ' || coalesce(r.msg, '(it ran)') from t._try(actor, q, false) r $$;

select t.ok('[c27] precondition: exactly one organization exists',
  $$ select count(*) = 1 from public.organizations $$);

insert into public.organizations (id, name, created_at)
  values (t.uid('org_second'), 'Second', timestamptz '2000-01-01 00:00:00+00');

-- ---------------------------------------------------------------------------
-- Decision 28: what "a ban deactivated it" means over time
-- ---------------------------------------------------------------------------

-- g1: banned and unbanned once; deactivated directly afterwards. A later ban
-- and unban must not bring the membership back: the first unban settled the
-- first ban.
insert into auth.users (id, email) values (t.uid('g1'), 'g1@db-test.invalid');
update auth.users set banned_until = now() + interval '876000 hours' where id = t.uid('g1');
update auth.users set banned_until = null where id = t.uid('g1');
select t.ok('[c28] setup: banned, then unbanned: active again',
  $$ select t.m('g1') = 'Driller/active/-' $$);
update public.memberships set status = 'deactivated' where user_id = t.uid('g1');   -- by an administrator
update auth.users set banned_until = now() + interval '876000 hours' where id = t.uid('g1');
update auth.users set banned_until = null where id = t.uid('g1');
select t.ok('[c28] a membership deactivated directly AFTER an earlier ban and unban is not reactivated by the next unban',
  $$ select t.m('g1') = 'Driller/deactivated/-' $$);
select t.none('[c28] ... and the account still reads nothing', 'g1',
  $$ select id from public.organizations $$);

-- g2: banned (which deactivates), reactivated directly while still banned,
-- then deactivated directly. The deactivation in force is the direct one.
insert into auth.users (id, email) values (t.uid('g2'), 'g2@db-test.invalid');
update auth.users set banned_until = now() + interval '876000 hours' where id = t.uid('g2');
update public.memberships set status = 'active' where user_id = t.uid('g2');        -- by an administrator
update public.memberships set status = 'deactivated' where user_id = t.uid('g2');   -- and again, on purpose
select t.ok('[c28] setup: deactivated by a ban, reactivated directly, then deactivated directly',
  $$ select t.m('g2') = 'Driller/deactivated/-' $$);
update auth.users set banned_until = null where id = t.uid('g2');
select t.ok('[c28] the unban does NOT reactivate it: the deactivation in force was made directly, after the ban''s',
  $$ select t.m('g2') = 'Driller/deactivated/-' $$);

-- Decision 24: an expired ban counts as active. Written by the auth server as
-- a date in the past.
insert into auth.users (id, email) values (t.uid('g3'), 'g3@db-test.invalid');
update auth.users set banned_until = now() - interval '1 day' where id = t.uid('g3');
select t.ok('[c24] banned_until set to a date that has passed does not deactivate the membership',
  $$ select t.m('g3') = 'Driller/active/-' $$);
update auth.users set banned_until = now() + interval '876000 hours' where id = t.uid('g3');
select t.ok('[c24] setup: a ban in force deactivates it',
  $$ select t.m('g3') = 'Driller/deactivated/-' $$);
update auth.users set banned_until = now() - interval '1 hour' where id = t.uid('g3');
select t.ok('[c24][c28] moving that ban to a date that has passed counts as lifting it: active again',
  $$ select t.m('g3') = 'Driller/active/-' $$);

-- Assumed reading (the criteria name only active and deactivated): a ban
-- deactivates an ACTIVE membership. An invitation that has not been accepted
-- is neither cancelled by a ban nor accepted by an unban.
insert into auth.users (id, email) values (t.uid('g4'), 'g4@db-test.invalid');
update public.memberships set status = 'invited' where user_id = t.uid('g4');
update auth.users set banned_until = now() + interval '876000 hours' where id = t.uid('g4');
select t.ok('[c28] assumed reading: a ban leaves an invited membership invited',
  $$ select t.m('g4') = 'Driller/invited/-' $$);
update auth.users set banned_until = null where id = t.uid('g4');
select t.ok('[c28] assumed reading: ... and the unban does not turn the invitation into an active membership',
  $$ select t.m('g4') = 'Driller/invited/-' $$);

-- Decision 27: an unban reaches the founding membership and no other, even
-- one that carries the ban mark (written directly here; the mirror itself
-- never sets it outside the founding organization).
insert into auth.users (id, email) values (t.uid('g5'), 'g5@db-test.invalid');
delete from public.memberships where user_id = t.uid('g5');
insert into public.memberships (org_id, user_id, role, status) values (t.uid('org_second'), t.uid('g5'), 'Supervisor', 'deactivated');
select t.did('[c27] setup (names deactivated_by_ban): a deactivated membership in another organization carries the ban mark', null,
  format('update public.memberships set deactivated_by_ban = true where user_id = %L', t.uid('g5')), 1);
update auth.users set banned_until = now() + interval '876000 hours' where id = t.uid('g5');
update auth.users set banned_until = null where id = t.uid('g5');
select t.ok('[c27] ... and an unban of that account still does NOT reactivate it',
  $$ select t.m('g5') = 'Supervisor/deactivated/-' $$);

-- ---------------------------------------------------------------------------
-- Criterion 12: a borehole sent without org_id says nothing about anyone else
-- ---------------------------------------------------------------------------
-- The caller's own memberships decide where such a borehole goes. Naming
-- someone else as created_by is refused, and refused the same way whoever is
-- named: otherwise the refusal would tell a member of one organization how
-- many organizations another account belongs to.

insert into auth.users (id, email)
  select t.uid(a), a || '@db-test.invalid' from unnest(array['g_caller', 'g_admin', 'g_one', 'g_none', 'g_two', 'g_off']) a;
update public.memberships set role = 'Administrator' where user_id = t.uid('g_admin');
delete from public.memberships where user_id in (t.uid('g_one'), t.uid('g_none'), t.uid('g_two'), t.uid('g_off'));
insert into public.memberships (org_id, user_id, role, status) values
  (t.uid('org_second'), t.uid('g_one'), 'Driller', 'active'),
  (t.f(),               t.uid('g_two'), 'Driller', 'active'),
  (t.uid('org_second'), t.uid('g_two'), 'Driller', 'active'),
  (t.uid('org_second'), t.uid('g_off'), 'Driller', 'deactivated');

select t.ok('[c12] setup: the caller is a Driller of the founding organization only; the named accounts have one, no, two and one deactivated membership',
  $$ select t.m('g_caller') = 'Driller/active/-' and t.m('g_admin') = 'Administrator/active/-' and t.m('g_none') = 'no membership'
        and (select count(*) from public.memberships where user_id = t.uid('g_one') and status = 'active') = 1
        and (select count(*) from public.memberships where user_id = t.uid('g_two') and status = 'active') = 2
        and (select count(*) from public.memberships where user_id = t.uid('g_off') and status = 'active') = 0 $$);

select t.throws(format('[c12] a borehole without org_id naming %s as its author is refused (42501)', target), 'g_caller',
  t.ins('boreholes', t.uid('new'), null, t.uid(target)), '42501')
from (values ('g_one'), ('g_none'), ('g_two'), ('g_off')) v(target);
select t.ok(format('[c12] ... and the refusal for %s reads exactly like the one for an account with one membership', target),
  format($$ select t.refusal('g_caller', %L) = t.refusal('g_caller', %L) $$,
         t.ins('boreholes', t.uid('new'), null, t.uid(target)),
         t.ins('boreholes', t.uid('new'), null, t.uid('g_one'))))
     || coalesce(' (got: ' || nullif(t.refusal('g_caller', t.ins('boreholes', t.uid('new'), null, t.uid(target))),
                                    t.refusal('g_caller', t.ins('boreholes', t.uid('new'), null, t.uid('g_one')))) || ')', '')
from (values ('g_none'), ('g_two'), ('g_off')) v(target);

-- The service role has no user of its own: for it the named author decides.
select t.ok('[c8] the service role sends a borehole without org_id: the named author''s one active membership decides', 'service',
  format('with i as (%s returning org_id) select org_id = %L from i',
         t.ins('boreholes', t.uid('new'), null, t.uid('g_one')), t.uid('org_second')));
select t.throws('[c8] ... and with a named author in two organizations it is refused (42501)', 'service',
  t.ins('boreholes', t.uid('new'), null, t.uid('g_two')), '42501');

-- ---------------------------------------------------------------------------
-- Decision 31 and criterion 25: who may call what
-- ---------------------------------------------------------------------------

select t.ok('[c31] (names founding_org_id) neither a signed-out nor a signed-in client holds EXECUTE on founding_org_id(); the service role does',
  $$ select to_regprocedure('public.founding_org_id()') is not null
        and not has_function_privilege('anon', 'public.founding_org_id()', 'EXECUTE')
        and not has_function_privilege('authenticated', 'public.founding_org_id()', 'EXECUTE')
        and has_function_privilege('service_role', 'public.founding_org_id()', 'EXECUTE') $$);
select t.throws('[c12] (names founding_org_id) a member of another organization cannot ask which organization is the founding one', 'g_one',
  $$ select public.founding_org_id() $$, '42501');
-- The same from either start (hosted default grants, or none): signed-in
-- users and the service role keep the pre-tenancy helpers, which the
-- rollback's policies call; a signed-out client does not.
select t.ok(format('[c25][c31] %s: EXECUTE for authenticated and service_role, not for anon', sig),
  format($$ select has_function_privilege('authenticated', %1$L, 'EXECUTE')
               and has_function_privilege('service_role', %1$L, 'EXECUTE')
               and not has_function_privilege('anon', %1$L, 'EXECUTE') $$, 'public.' || sig))
from (values ('is_admin()'), ('is_reviewer()'), ('shares_org_as(uuid,text[])'), ('reads_legacy_photos_of(uuid)')) v(sig);

-- ---------------------------------------------------------------------------
-- Decisions 27 and 30: there is one founding organization, or none
-- ---------------------------------------------------------------------------

select t.throws('[c27][c30] (names is_founding) a second organization cannot be marked founding as well', null,
  format('update public.organizations set is_founding = true where id = %L', t.uid('org_second')), '23505');
select t.throws('[c27][c30] (names is_founding) nor can one be created already marked', null,
  $$ insert into public.organizations (name, is_founding) values ('Third', true) $$, '23505');
select t.none('[c12] (names is_founding) no signed-in user can move the mark: not even the founding organization''s Administrator', 'g_admin',
  format('update public.organizations set is_founding = false where id = %L', t.f()));

-- With no organization marked (never the case after the migration; it takes a
-- deliberate write), everything mirrored has no target: account creation and
-- the admin-users writes still go through, and nobody is enrolled anywhere.
select t.did('[c27] setup (names is_founding): no organization is marked founding', null,
  $$ update public.organizations set is_founding = false where is_founding $$, 1);
select t.did('[c27] with no founding organization, creating an account still goes through', null,
  format('insert into auth.users (id, email) values (%L, ''g6@db-test.invalid'')', t.uid('g6')), 1);
select t.ok('[c27] ... its profile exists and it is enrolled nowhere',
  $$ select (select count(*) from public.profiles where id = t.uid('g6')) = 1 and t.m('g6') = 'no membership' $$);
select t.did('[c27] ... a profile role and badge change still goes through', 'service',
  format('update public.profiles set role = ''Administrator'', badge_number = ''Z'' where id = %L', t.uid('g6')), 1);
select t.did('[c27] ... and so does a ban', null,
  format('update auth.users set banned_until = now() + interval ''876000 hours'' where id = %L', t.uid('g_two')), 1);
select t.ok('[c27] ... which changes no membership anywhere: there is no founding membership to reach',
  $$ select t.m('g6') = 'no membership'
        and (select count(*) from public.memberships where user_id = t.uid('g_two') and status = 'active') = 2 $$);

rollback;
select 'done';
