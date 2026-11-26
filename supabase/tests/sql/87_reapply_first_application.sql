-- Decisions 39, 45 and 46, and decision 31 beside them: WHEN an application
-- of the Drill migration brings the founding memberships into line with the
-- legacy tables and enrols accounts, and when it must leave them alone.
--
-- Added in the validation of f1aabbe. Each scenario failed against a scratch
-- copy of the migration with one of its conditions removed, and nothing else
-- in the suite did:
--   1  decision 46: an `invited` membership is left as it is; one deactivated
--      directly before the rollback is active again (status comes from the
--      ban alone)
--   2  decision 39 with 44: after the Drill rollback alone, the founding
--      organization is marked BY HAND (the procedure the migration's own
--      error gives) and the migration applied: the memberships still follow
--      the legacy tables. The migration is not in force then, however the
--      flag came to be set.
--   3  decision 45: a founding organization with no membership at all is a
--      first application even while the migration is in force: every profile
--      THAT HAS NO MEMBERSHIP IN ANY ORGANIZATION is enrolled (criterion 49,
--      which replaces "every profile"; see the note below). Decision 27: no
--      membership of another organization is touched by it.
--   4  decision 31: a plain re-application (in force, flagged, has members)
--      touches nothing, whatever the memberships say compared to the profiles
--   5  criterion 14: the Drill rollback run twice in a row, then the
--      migration, ends with tenancy in force
--   6  criterion 49, the reconciliation: after the Drill rollback alone, with
--      a second organization present, an account whose only membership is in
--      the second organization gets no founding membership; one with no
--      membership anywhere is enrolled
--
-- Criterion 49 (RF-093), written before its implementation. Scenario 3 used
-- to require that EVERY profile is enrolled in the founding organization,
-- the member of the other company included (what criteria 39 and 45 said
-- literally). Criterion 49 replaces that reading, so ONE check was changed:
--   was  "[c45] applied with a founding organization that has no membership:
--         every profile is enrolled there, with its role and badge"
--   is   "[c45][c49] ... every profile that has no membership in another
--         organization is enrolled there, with its role and badge"
-- and the checks marked [c49] were added. Nothing else was loosened.
--
-- One transaction that is rolled back; each scenario is undone at a
-- savepoint, so none sees another's rows. run.sh passes the file paths and
-- refuses to run this file when a migration or rollback file is missing or
-- contains transaction control. Scenario 2 names organizations.is_founding:
-- the instructions under test do.
-- plan: 50
begin;
\ir ../lib/helpers.sql
-- A migration later than the ones this file rehearses is rolled back first.
\ir inc/roll_back_later.sql

create function t.m(actor text) returns text
language sql stable
as $$
  select coalesce(string_agg(format('%s/%s/%s', role, status, coalesce(badge_number, '-')), ' + ' order by org_id), 'no membership')
  from public.memberships where user_id = t.uid(actor)
$$;

-- The account's membership in one organization.
create function t.mo(actor text, org uuid) returns text
language sql stable
as $$
  select coalesce((select format('%s/%s/%s', role, status, coalesce(badge_number, '-'))
                   from public.memberships where user_id = t.uid(actor) and org_id = org), 'no membership')
$$;

create function t.ban(actor text) returns void
language sql
as $$ update auth.users set banned_until = now() + interval '876000 hours' where id = t.uid(actor) $$;

create function t.unban(actor text) returns void
language sql
as $$ update auth.users set banned_until = null where id = t.uid(actor) $$;

select t.ok('[c39] precondition: exactly one organization exists and tenancy is applied',
  $$ select count(*) = 1
        and exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped)
     from public.organizations $$);

create table t.founding as select id from public.organizations;
grant select on t.founding to public;

create function t.f() returns uuid
language sql stable
as $$ select id from t.founding $$;

-- ---------------------------------------------------------------------------
-- 1. Decision 46: invited is left alone; status comes from the ban alone
-- ---------------------------------------------------------------------------
savepoint scenario;

insert into auth.users (id, email)
  select t.uid(a), a || '@db-test.invalid'
  from unnest(array['z_invited', 'z_invited_ban', 'z_direct', 'z_direct_ban']) a;
update public.memberships set status = 'invited' where user_id in (t.uid('z_invited'), t.uid('z_invited_ban'));
update public.memberships set status = 'deactivated' where user_id in (t.uid('z_direct'), t.uid('z_direct_ban'));

select t.ok('[c46] setup: two invited members and two deactivated directly, none banned',
  $$ select t.m('z_invited') = 'Driller/invited/-' and t.m('z_invited_ban') = 'Driller/invited/-'
        and t.m('z_direct') = 'Driller/deactivated/-' and t.m('z_direct_ban') = 'Driller/deactivated/-' $$);

\i :rollback_drill

-- While rolled back, on the legacy tables.
select t.ban('z_invited_ban');
update public.profiles set role = 'Supervisor', badge_number = 'Z-2' where id = t.uid('z_invited_ban');
select t.ban('z_direct_ban');

\i :mig_drill

select t.ok(format('[c46] re-applied after the Drill rollback alone: %s -> %s (found: %s)', what, expected, t.m(actor)),
  format($$ select t.m(%L) = %L $$, actor, expected))
from (values
  (1, 'z_invited',     'an invited membership is left invited',                                     'Driller/invited/-'),
  (2, 'z_invited_ban', 'an invited one banned and re-roled meanwhile stays invited, with the profile''s role and badge', 'Supervisor/invited/Z-2'),
  (3, 'z_direct',      'one deactivated directly before the rollback, not banned, is active',       'Driller/active/-'),
  (4, 'z_direct_ban',  'one deactivated directly before the rollback and banned meanwhile is deactivated', 'Driller/deactivated/-')
) v(i, actor, what, expected)
order by i;

select t.none('[c46] ... the invited member reads nothing: an invitation is not a membership in force', 'z_invited',
  $$ select id from public.organizations $$);
select t.unban('z_invited_ban');
select t.ok('[c46][c44] ... lifting the ban of the invited one does not accept the invitation',
  $$ select t.m('z_invited_ban') = 'Supervisor/invited/Z-2' $$);
select t.unban('z_direct_ban');
select t.ok('[c46][c28] ... lifting the ban found at re-application reactivates that membership: it is marked as the ban''s',
  $$ select t.m('z_direct_ban') = 'Driller/active/-' $$);

rollback to savepoint scenario;

-- ---------------------------------------------------------------------------
-- 2. Decisions 39 and 44: the flag set by hand after the Drill rollback alone
-- ---------------------------------------------------------------------------
savepoint scenario;

insert into auth.users (id, email)
  select t.uid(a), a || '@db-test.invalid' from unnest(array['h_demoted', 'h_banned', 'h_unbanned']) a;
update public.profiles set role = 'Administrator' where id = t.uid('h_demoted');
select t.ban('h_unbanned');
-- A second organization with nobody in it and no records: the rollback does
-- not refuse for it, and the migration afterwards cannot tell which of the
-- two is the founding one. Older than the founding one: age must not decide.
insert into public.organizations (id, name, created_at)
  values (t.uid('org_empty'), 'Empty company', timestamptz '2000-01-01 00:00:00+00');

select t.ok('[c39] setup: an Administrator, a Driller and a banned Driller in the founding organization; a second, empty organization',
  $$ select t.m('h_demoted') = 'Administrator/active/-' and t.m('h_banned') = 'Driller/active/-'
        and t.m('h_unbanned') = 'Driller/deactivated/-'
        and (select count(*) from public.memberships where org_id = t.uid('org_empty')) = 0 $$);

\i :rollback_drill

select t.ok('[c39] setup: the rollback ran (boreholes has no org_id) and kept the memberships',
  $$ select not exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped)
        and t.m('h_demoted') = 'Administrator/active/-' $$);

update public.profiles set role = 'Driller' where id = t.uid('h_demoted');
select t.ban('h_banned');
select t.unban('h_unbanned');
insert into auth.users (id, email, raw_user_meta_data)
  values (t.uid('h_new'), 'h_new@db-test.invalid', '{"badge_number": "H-4"}');

-- What the migration's error says to do when it cannot tell (decision 44).
alter table public.organizations add column if not exists is_founding boolean not null default false;
update public.organizations set is_founding = true where id = t.f();

\i :mig_drill

select t.ok(format('[c39][c44] flag set by hand after the Drill rollback alone, then applied: %s -> %s (found: %s)', what, expected, t.m(actor)),
  format($$ select t.m(%L) = %L $$, actor, expected))
from (values
  (1, 'h_demoted',  'the Administrator demoted meanwhile',    'Driller/active/-'),
  (2, 'h_banned',   'the account banned meanwhile',           'Driller/deactivated/-'),
  (3, 'h_unbanned', 'the banned account unbanned meanwhile',  'Driller/active/-'),
  (4, 'h_new',      'the account created meanwhile',          'Driller/active/H-4')
) v(i, actor, what, expected)
order by i;
select t.none('[c39][c44] ... the demoted Administrator no longer administers the founding organization', 'h_demoted',
  format('select 1 where public.is_org_admin(%L)', t.f()));
select t.ok('[c39][c44] ... the organization flagged by hand is the founding one, and nobody was enrolled in the other',
  $$ select (select string_agg(id::text, ',') from public.organizations where is_founding) = t.f()::text
        and (select count(*) from public.memberships where org_id = t.uid('org_empty')) = 0 $$);
select t.ok('[c39][c44] ... and a borehole sent without org_id by the new account lands in the founding organization', 'h_new',
  format('with i as (%s returning org_id) select org_id = %L from i',
         t.ins('boreholes', t.uid('new'), null, t.uid('h_new')), t.f()));

rollback to savepoint scenario;

-- ---------------------------------------------------------------------------
-- 3. Decision 45: no membership at all is a first application, in force too
-- ---------------------------------------------------------------------------
savepoint scenario;

insert into auth.users (id, email, raw_user_meta_data) values
  (t.uid('e_super'),  'e_super@db-test.invalid',  '{"badge_number": "E-1"}'),
  (t.uid('e_banned'), 'e_banned@db-test.invalid', null),
  (t.uid('o_other'),  'o_other@db-test.invalid',  null),
  (t.uid('o_invited'), 'o_invited@db-test.invalid', '{"badge_number": "E-8"}'),
  (t.uid('o_active'),  'o_active@db-test.invalid',  null);
update public.profiles set role = 'Supervisor' where id = t.uid('e_super');
update public.profiles set role = 'Administrator' where id = t.uid('o_active');
select t.ban('e_banned');

-- Another company with one member, whose membership there says something
-- else than the legacy profile (Driller) and the ban (none) do.
insert into public.organizations (id, name, created_at)
  values (t.uid('org_other'), 'Other company', timestamptz '2000-01-01 00:00:00+00');
insert into public.memberships (org_id, user_id, role, status, badge_number)
  values (t.uid('org_other'), t.uid('o_other'), 'Supervisor', 'deactivated', 'O-7');
-- Criterion 49: two more who belong to the other company and to nothing
-- else. One was only invited there; the other is an active Driller there
-- whose legacy profile says Administrator (enrolled in the founding
-- organization, they would administer it).
insert into public.memberships (org_id, user_id, role, status, badge_number) values
  (t.uid('org_other'), t.uid('o_invited'), 'Data Logger', 'invited', null),
  (t.uid('org_other'), t.uid('o_active'),  'Driller',     'active',  null);

-- The founding organization loses every membership (emptied by hand, or its
-- flag was moved to an organization nobody was enrolled in yet).
delete from public.memberships where org_id = t.f();

select t.ok('[c45] setup: the founding organization is flagged, tenancy is in force, and it has no membership at all',
  $$ select (select count(*) from public.memberships where org_id = t.f()) = 0
        and (select count(*) from public.profiles) >= 3
        and exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped) $$);

\i :mig_drill

select t.ok('[c45][c49] applied with a founding organization that has no membership: every profile that has no membership in another organization is enrolled there, with its role and badge (missing or differing: '
            || coalesce((select string_agg(u.email, ', ' order by u.email)
                         from public.profiles p join auth.users u on u.id = p.id
                         where not exists (select 1 from public.memberships o where o.user_id = p.id and o.org_id <> t.f())
                           and not exists (select 1 from public.memberships m
                                           where m.org_id = t.f() and m.user_id = p.id
                                             and m.role = p.role and m.badge_number is not distinct from p.badge_number)), 'none') || ')',
  $$ select not exists (select 1 from public.profiles p
                        where not exists (select 1 from public.memberships o where o.user_id = p.id and o.org_id <> t.f())
                          and not exists (select 1 from public.memberships m
                                          where m.org_id = t.f() and m.user_id = p.id
                                            and m.role = p.role and m.badge_number is not distinct from p.badge_number))
        and (select count(*) from public.memberships where org_id = t.f()) >= 2 $$);
select t.ok(format('[c49] ... %s gets NO founding membership (found there: %s)', what, t.mo(actor, t.f())),
  format($$ select t.mo(%L, t.f()) = 'no membership' $$, actor))
from (values
  (1, 'o_other',   'the account whose only membership is a deactivated one in the other company'),
  (2, 'o_invited', 'the account whose only membership is an invitation to the other company'),
  (3, 'o_active',  'the active member of the other company whose legacy profile says Administrator')
) v(i, actor, what)
order by i;
select t.ok('[c49] ... nobody who belongs to another organization was added to the founding one (added: '
            || coalesce((select string_agg(u.email, ', ' order by u.email)
                         from public.memberships m join auth.users u on u.id = m.user_id
                         where m.org_id = t.f()
                           and exists (select 1 from public.memberships o where o.user_id = m.user_id and o.org_id <> t.f())), 'none') || ')',
  $$ select not exists (select 1 from public.memberships m
                        where m.org_id = t.f()
                          and exists (select 1 from public.memberships o where o.user_id = m.user_id and o.org_id <> t.f())) $$);
select t.none('[c49] ... so the other company''s member whose legacy profile says Administrator administers nothing in the founding organization', 'o_active',
  format('select 1 where public.is_org_admin(%L) or public.is_org_member(%L)', t.f(), t.f()));
select t.ok('[c49] ... the other two memberships in the other company are exactly as they were',
  $$ select t.mo('o_invited', t.uid('org_other')) = 'Data Logger/invited/-'
        and t.mo('o_active', t.uid('org_other')) = 'Driller/active/-' $$);
select t.ok('[c45] ... a Supervisor with a badge is enrolled as that',
  $$ select t.mo('e_super', t.f()) = 'Supervisor/active/E-1' $$);
select t.ok('[c45][c6] ... a banned account is enrolled deactivated',
  $$ select t.mo('e_banned', t.f()) = 'Driller/deactivated/-' $$);
select t.ok('[c45][c27] ... the other company''s membership is exactly as it was: not re-roled, not reactivated, badge kept (found: ' || t.mo('o_other', t.uid('org_other')) || ')',
  $$ select t.mo('o_other', t.uid('org_other')) = 'Supervisor/deactivated/O-7' $$);
select t.ok('[c45][c27] ... and nobody was added to the other company',
  $$ select count(*) = 3 from public.memberships where org_id = t.uid('org_other') $$);
select t.unban('e_banned');
select t.ok('[c45][c28] ... lifting the ban reactivates the membership enrolled deactivated',
  $$ select t.mo('e_banned', t.f()) = 'Driller/active/-' $$);

rollback to savepoint scenario;

-- ---------------------------------------------------------------------------
-- 4. Decision 31: a plain re-application leaves every membership alone
-- ---------------------------------------------------------------------------
savepoint scenario;

insert into auth.users (id, email)
  select t.uid(a), a || '@db-test.invalid' from unnest(array['p_diff', 'p_off', 'p_inv', 'p_ban', 'p_mixed']) a;
-- Managed on the memberships directly, as saas-members will: the legacy
-- profile says Driller, no badge, for all of them.
update public.memberships set role = 'Supervisor', badge_number = 'P-1' where user_id = t.uid('p_diff');
update public.memberships set status = 'deactivated' where user_id = t.uid('p_off');
update public.memberships set status = 'invited' where user_id = t.uid('p_inv');
select t.ban('p_ban');
-- Banned, then reactivated directly: active although the account is banned.
select t.ban('p_mixed');
update public.memberships set status = 'active' where user_id = t.uid('p_mixed');

create table t.before as
  select user_id, org_id, role, status, badge_number from public.memberships;

\i :mig_drill

select t.ok(format('[c31] a plain re-application leaves %s as it was: %s (found: %s)', what, expected, t.m(actor)),
  format($$ select t.m(%L) = %L $$, actor, expected))
from (values
  (1, 'p_diff',  'a membership whose role and badge differ from the profile''s', 'Supervisor/active/P-1'),
  (2, 'p_off',   'one deactivated directly, the account not banned',             'Driller/deactivated/-'),
  (3, 'p_inv',   'an invited one',                                               'Driller/invited/-'),
  (4, 'p_ban',   'one a ban deactivated',                                        'Driller/deactivated/-'),
  (5, 'p_mixed', 'one reactivated directly while the account is banned',         'Driller/active/-')
) v(i, actor, what, expected)
order by i;
select t.ok('[c31] ... and every other membership too: none changed, none added, none removed',
  $$ select not exists (select user_id, org_id, role, status, badge_number from public.memberships
                        except select * from t.before)
        and not exists (select * from t.before
                        except select user_id, org_id, role, status, badge_number from public.memberships) $$);
select t.unban('p_off');
select t.ok('[c31][c28] ... the one deactivated directly is still not reactivated by an unban',
  $$ select t.m('p_off') = 'Driller/deactivated/-' $$);
select t.unban('p_ban');
select t.ok('[c31][c28] ... and the one the ban deactivated still is',
  $$ select t.m('p_ban') = 'Driller/active/-' $$);

rollback to savepoint scenario;

-- ---------------------------------------------------------------------------
-- 5. Criterion 14: the Drill rollback twice in a row, then the migration
-- ---------------------------------------------------------------------------
savepoint scenario;

insert into auth.users (id, email) values (t.uid('w_twice'), 'w_twice@db-test.invalid');
update public.profiles set role = 'Administrator' where id = t.uid('w_twice');

\i :rollback_drill
\i :rollback_drill

select t.ok('[c14] the Drill rollback run a second time changes nothing more: the foundation and its rows are there, org_id is gone',
  $$ select t.m('w_twice') = 'Administrator/active/-'
        and not exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped) $$);

update public.profiles set role = 'Driller' where id = t.uid('w_twice');

\i :mig_drill

select t.ok('[c14][c39] ... and the migration applied after it is in force again, with the memberships following the legacy tables',
  $$ select t.m('w_twice') = 'Driller/active/-'
        and exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped)
        and (select count(*) from public.organizations where is_founding) = 1 $$);

rollback to savepoint scenario;

-- ---------------------------------------------------------------------------
-- 6. Criterion 49: the reconciliation, with a second organization present
-- ---------------------------------------------------------------------------
-- After the Drill rollback alone the foundation's tables are still there and
-- the mirror is not. A second company is given its first members then (the
-- rollback itself refuses while it has any, decision 41), and an account is
-- created. The migration is applied again; with two organizations the mark is
-- set by hand first, as its own error says to (decision 44).
savepoint scenario;

insert into auth.users (id, email, raw_user_meta_data) values
  (t.uid('q_stays'), 'q_stays@db-test.invalid', '{"badge_number": "Q-1"}'),
  (t.uid('q_moved'), 'q_moved@db-test.invalid', null),
  (t.uid('q_moved_banned'), 'q_moved_banned@db-test.invalid', null);
update public.profiles set role = 'Administrator' where id = t.uid('q_moved');
insert into public.organizations (id, name, created_at)
  values (t.uid('org_second'), 'Second company', timestamptz '2000-01-01 00:00:00+00');

select t.ok('[c49] setup: three founding members, one an Administrator; a second organization with nobody in it',
  $$ select t.m('q_stays') = 'Driller/active/Q-1' and t.m('q_moved') = 'Administrator/active/-'
        and t.m('q_moved_banned') = 'Driller/active/-'
        and (select count(*) from public.memberships where org_id = t.uid('org_second')) = 0 $$);

\i :rollback_drill

-- While rolled back. Two accounts leave the founding company for the second
-- one (there a Driller and a Supervisor); one of them is banned meanwhile,
-- and their legacy profiles say something else than their new memberships.
delete from public.memberships where user_id in (t.uid('q_moved'), t.uid('q_moved_banned'));
insert into public.memberships (org_id, user_id, role, status, badge_number) values
  (t.uid('org_second'), t.uid('q_moved'),        'Driller',    'active', 'S-5'),
  (t.uid('org_second'), t.uid('q_moved_banned'), 'Supervisor', 'active', null);
select t.ban('q_moved_banned');
update public.profiles set badge_number = 'Q-9' where id = t.uid('q_moved_banned');
-- Created while rolled back: no mirror, so no membership anywhere.
insert into auth.users (id, email, raw_user_meta_data)
  values (t.uid('q_new'), 'q_new@db-test.invalid', '{"badge_number": "Q-4"}');
update public.profiles set role = 'Supervisor' where id = t.uid('q_new');

select t.ok('[c49] setup: rolled back; two accounts belong to the second organization only, one account has no membership anywhere',
  $$ select not exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped)
        and t.m('q_moved') = 'Driller/active/S-5' and t.m('q_moved_banned') = 'Supervisor/active/-'
        and t.m('q_new') = 'no membership' and t.m('q_stays') = 'Driller/active/Q-1' $$);

alter table public.organizations add column if not exists is_founding boolean not null default false;
update public.organizations set is_founding = true where id = t.f();

\i :mig_drill

select t.ok(format('[c49] re-applied after the Drill rollback alone, a second organization present: %s (found in the founding organization: %s)', what, t.mo(actor, t.f())),
  format($$ select t.mo(%L, t.f()) = %L $$, actor, expected))
from (values
  (1, 'q_moved',        'the account that now belongs to the second organization only gets no founding membership', 'no membership'),
  (2, 'q_moved_banned', 'nor does the one that was banned meanwhile',                                               'no membership'),
  (3, 'q_new',          'the account with no membership anywhere is enrolled, with its profile''s role and badge',   'Supervisor/active/Q-4'),
  (4, 'q_stays',        'the founding member nothing happened to is as before',                                     'Driller/active/Q-1')
) v(i, actor, what, expected)
order by i;
select t.ok('[c49][c27] ... the memberships in the second organization are exactly as they were: not re-roled, not deactivated by the ban, badges kept (found: '
            || t.mo('q_moved', t.uid('org_second')) || ' and ' || t.mo('q_moved_banned', t.uid('org_second')) || ')',
  $$ select t.mo('q_moved', t.uid('org_second')) = 'Driller/active/S-5'
        and t.mo('q_moved_banned', t.uid('org_second')) = 'Supervisor/active/-'
        and (select count(*) from public.memberships where org_id = t.uid('org_second')) = 2 $$);
select t.none('[c49] ... the legacy Administrator who moved to the second organization does not administer the founding one', 'q_moved',
  format('select 1 where public.is_org_admin(%L) or public.is_org_member(%L)', t.f(), t.f()));
select t.ok('[c49][c8] ... and their borehole sent without org_id lands in the second organization, their only one', 'q_moved',
  format('with i as (%s returning org_id) select org_id = %L from i',
         t.ins('boreholes', t.uid('new'), null, t.uid('q_moved')), t.uid('org_second')));

rollback to savepoint scenario;

rollback;
select 'done';
