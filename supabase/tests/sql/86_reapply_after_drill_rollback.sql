-- Decision 39 (RF-079): the membership in the founding organization always
-- follows the legacy tables once the Drill migration is through, whatever
-- happened while it was rolled back.
--
-- The Drill rollback on its own (without the saas_core rollback) keeps the
-- organizations and memberships and takes the mirror triggers away. While it
-- is in that state the dashboard keeps working on the legacy tables: an
-- Administrator is demoted, someone is promoted, an account is banned, another
-- is unbanned. When the Drill migration is applied again it marks the founding
-- organization again, and at that moment every founding membership must be
-- brought into line with its profile (role, badge) and with the account's ban.
-- Otherwise the demoted Administrator is an Administrator again.
--
-- Inside one transaction that is rolled back. run.sh passes the file paths and
-- refuses to run this file when a migration or rollback file is missing or
-- contains transaction control. run.sh runs against a database that started
-- with no default grants (CI) and local.sh also against one that started with
-- a hosted project's: both grant cases.
--
-- Not asserted here, because the criteria do not say (reported as open): what
-- the re-application does with a membership that was deactivated DIRECTLY, or
-- was still `invited`, before the rollback. The rollback drops the mark that
-- tells a ban's deactivation from a direct one.
-- plan: 30
begin;
\ir ../lib/helpers.sql

create function t.m(actor text) returns text
language sql stable
as $$
  select coalesce(string_agg(format('%s/%s/%s', role, status, coalesce(badge_number, '-')), ' + ' order by org_id), 'no membership')
  from public.memberships where user_id = t.uid(actor)
$$;

select t.ok('[c39] precondition: exactly one organization exists and tenancy is applied',
  $$ select count(*) = 1
        and exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped)
     from public.organizations $$);

create table t.founding as select id from public.organizations;
grant select on t.founding to public;

-- The cast, created while the migration is in force: the mirror enrols them.
insert into auth.users (id, email, raw_user_meta_data) values
  (t.uid('ry_demoted'),     'ry_demoted@db-test.invalid',     null),
  (t.uid('ry_promoted'),    'ry_promoted@db-test.invalid',    null),
  (t.uid('ry_banned'),      'ry_banned@db-test.invalid',      null),
  (t.uid('ry_unbanned'),    'ry_unbanned@db-test.invalid',    null),
  (t.uid('ry_stillbanned'), 'ry_stillbanned@db-test.invalid', null),
  (t.uid('ry_badge'),       'ry_badge@db-test.invalid',       '{"badge_number": "Y-1"}'),
  (t.uid('ry_both'),        'ry_both@db-test.invalid',        null),
  (t.uid('ry_same'),        'ry_same@db-test.invalid',        '{"badge_number": "Y-9"}');
update public.profiles set role = 'Administrator' where id = t.uid('ry_demoted');
update public.profiles set role = 'Supervisor'    where id in (t.uid('ry_both'), t.uid('ry_same'));
update auth.users set banned_until = now() + interval '876000 hours'
  where id in (t.uid('ry_unbanned'), t.uid('ry_stillbanned'));

select t.ok('[c39] setup: eight founding members, one an Administrator, two deactivated by a ban',
  $$ select t.m('ry_demoted') = 'Administrator/active/-' and t.m('ry_promoted') = 'Driller/active/-'
        and t.m('ry_banned') = 'Driller/active/-' and t.m('ry_unbanned') = 'Driller/deactivated/-'
        and t.m('ry_stillbanned') = 'Driller/deactivated/-' and t.m('ry_badge') = 'Driller/active/Y-1'
        and t.m('ry_both') = 'Supervisor/active/-' and t.m('ry_same') = 'Supervisor/active/Y-9' $$);
select t.rows('[c39] setup: the Administrator administers the founding organization', 'ry_demoted',
  format('select 1 where public.is_org_admin(%L)', (select id from t.founding)), 1);

\i :rollback_drill

select t.ok('[c39] setup: the Drill rollback alone kept the organization and the eight memberships',
  $$ select (select count(*) from public.organizations) = 1
        and (select count(*) from public.memberships where org_id = (select id from t.founding)
               and user_id in (select id from auth.users where email like 'ry\_%@db-test.invalid')) = 8 $$);

-- What the dashboard (the admin-users function) does while the Drill
-- migration is rolled back: it writes profiles and bans, as it always has.
select t.did('[c39] while rolled back: an Administrator is demoted to Driller', null,
  format('update public.profiles set role = ''Driller'' where id = %L', t.uid('ry_demoted')), 1);
select t.did('[c39] while rolled back: a Driller is promoted to Supervisor', null,
  format('update public.profiles set role = ''Supervisor'' where id = %L', t.uid('ry_promoted')), 1);
select t.did('[c39] while rolled back: an account is banned', null,
  format('update auth.users set banned_until = now() + interval ''876000 hours'' where id = %L', t.uid('ry_banned')), 1);
select t.did('[c39] while rolled back: an account banned before is unbanned', null,
  format('update auth.users set banned_until = null where id = %L', t.uid('ry_unbanned')), 1);
select t.did('[c39] while rolled back: a badge number is changed', null,
  format('update public.profiles set badge_number = ''Y-2'' where id = %L', t.uid('ry_badge')), 1);
select t.did('[c39] while rolled back: a Supervisor is made Data Logger and banned', null,
  format('with p as (update public.profiles set role = ''Data Logger'' where id = %1$L returning 1)
          update auth.users set banned_until = now() + interval ''876000 hours'' where id = %1$L', t.uid('ry_both')), 1);
select t.did('[c39] while rolled back: an account is created, as a Supervisor with a badge', null,
  format('insert into auth.users (id, email, raw_user_meta_data) values (%L, ''ry_new@db-test.invalid'', ''{"badge_number": "Y-3"}'')', t.uid('ry_new')), 1);
update public.profiles set role = 'Supervisor' where id = t.uid('ry_new');

\i :mig_drill

select t.ok(format('[c39] re-applied after the Drill rollback alone: %s -> the founding membership is %s (found: %s)', what, expected, t.m(actor)),
  format($$ select t.m(%L) = %L $$, actor, expected))
from (values
  (1, 'ry_demoted',     'the Administrator demoted meanwhile',           'Driller/active/-'),
  (2, 'ry_promoted',    'the Driller promoted meanwhile',                'Supervisor/active/-'),
  (3, 'ry_banned',      'the account banned meanwhile',                  'Driller/deactivated/-'),
  (4, 'ry_unbanned',    'the banned account unbanned meanwhile',         'Driller/active/-'),
  (5, 'ry_badge',       'the badge changed meanwhile',                   'Driller/active/Y-2'),
  (6, 'ry_both',        'the Supervisor re-roled and banned meanwhile',  'Data Logger/deactivated/-'),
  (7, 'ry_stillbanned', 'the account banned before and still banned',    'Driller/deactivated/-'),
  (8, 'ry_same',        'the member nothing happened to',                'Supervisor/active/Y-9'),
  (9, 'ry_new',         'the account created meanwhile',                 'Supervisor/active/Y-3')
) v(i, actor, what, expected)
order by i;

select t.ok('[c39] ... every founding membership carries its profile''s role and badge (differing: '
            || coalesce((select string_agg(u.email, ', ' order by u.email)
                         from public.memberships m join public.profiles p on p.id = m.user_id join auth.users u on u.id = m.user_id
                         where m.org_id = (select id from t.founding)
                           and (m.role is distinct from p.role or m.badge_number is distinct from p.badge_number)), 'none') || ')',
  $$ select not exists (select 1 from public.memberships m join public.profiles p on p.id = m.user_id
                        where m.org_id = (select id from t.founding)
                          and (m.role is distinct from p.role or m.badge_number is distinct from p.badge_number)) $$);
select t.ok('[c39] ... every founding membership is deactivated exactly when its account is banned (differing: '
            || coalesce((select string_agg(u.email, ', ' order by u.email)
                         from public.memberships m join auth.users u on u.id = m.user_id
                         where m.org_id = (select id from t.founding)
                           and (m.status = 'deactivated') is distinct from coalesce(u.banned_until > now(), false)), 'none') || ')',
  $$ select not exists (select 1 from public.memberships m join auth.users u on u.id = m.user_id
                        where m.org_id = (select id from t.founding)
                          and (m.status = 'deactivated') is distinct from coalesce(u.banned_until > now(), false)) $$);
select t.ok('[c39] ... there is still exactly one organization, and it gained one membership: the new account''s',
  $$ select (select count(*) from public.organizations) = 1
        and (select count(*) from public.memberships
             where user_id in (select id from auth.users where email like 'ry\_%@db-test.invalid')) = 9 $$);

-- What it means for the people concerned.
select t.none('[c39] ... the demoted Administrator no longer administers the founding organization', 'ry_demoted',
  format('select 1 where public.is_org_admin(%L)', (select id from t.founding)));
select t.none('[c39] ... and no longer reads the other members'' memberships', 'ry_demoted',
  format('select user_id from public.memberships where user_id <> %L', t.uid('ry_demoted')));
select t.none('[c39] ... the account banned meanwhile reads nothing: not even its organization', 'ry_banned',
  $$ select id from public.organizations $$);
select t.rows('[c39] ... the account unbanned meanwhile reads its organization again', 'ry_unbanned',
  $$ select id from public.organizations $$, 1);

-- The mirror is back, and a ban found at re-application is still a ban's
-- deactivation (decision 28): lifting it brings the membership back.
update auth.users set banned_until = null where id = t.uid('ry_banned');
select t.ok('[c39][c28] ... lifting the ban made meanwhile reactivates that membership',
  $$ select t.m('ry_banned') = 'Driller/active/-' $$);
update auth.users set banned_until = null where id = t.uid('ry_stillbanned');
select t.ok('[c39][c28] ... as does lifting the ban that was in force all along',
  $$ select t.m('ry_stillbanned') = 'Driller/active/-' $$);
update public.profiles set role = 'Administrator' where id = t.uid('ry_promoted');
select t.ok('[c39] ... and a later role change is mirrored as before',
  $$ select t.m('ry_promoted') = 'Administrator/active/-' $$);

rollback;
select 'done';
