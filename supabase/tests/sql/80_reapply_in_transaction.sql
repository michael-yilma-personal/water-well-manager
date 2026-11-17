-- Decision 31: applying the Drill migration a second time is not a second
-- enrolment. A member whose membership was deleted after the first run stays
-- out; everyone else keeps exactly what they had. Inside one transaction that
-- is rolled back. run.sh passes the file path and refuses to run this file
-- when the migration is missing or contains transaction control.
-- plan: 8
begin;
\ir ../lib/helpers.sql

create function t.m(actor text) returns text
language sql stable
as $$
  select coalesce(string_agg(format('%s/%s/%s', role, status, coalesce(badge_number, '-')), ' + ' order by org_id), 'no membership')
  from public.memberships where user_id = t.uid(actor)
$$;

select t.ok('[c31] precondition: exactly one organization exists',
  $$ select count(*) = 1 from public.organizations $$);

insert into auth.users (id, email, raw_user_meta_data) values
  (t.uid('r_removed'), 'r_removed@db-test.invalid', '{"badge_number": "R-1"}'),
  (t.uid('r_kept'),    'r_kept@db-test.invalid',    '{"badge_number": "R-2"}'),
  (t.uid('r_off'),     'r_off@db-test.invalid',     null);
update public.profiles set role = 'Supervisor' where id = t.uid('r_kept');
update public.memberships set status = 'deactivated' where user_id = t.uid('r_off');

select t.ok('[c31] setup: three members of the founding organization',
  $$ select t.m('r_removed') = 'Driller/active/R-1' and t.m('r_kept') = 'Supervisor/active/R-2' and t.m('r_off') = 'Driller/deactivated/-' $$);

-- Removed from the organization after the first run. The profile remains.
delete from public.memberships where user_id = t.uid('r_removed');

create table t.before as
  select (select count(*) from public.organizations) as orgs,
         (select count(*) from public.memberships) as members,
         (select count(*) from pg_policies where schemaname in ('public', 'storage')) as policies;

\i :mig_drill

select t.ok('[c31] a second application does NOT re-enrol the member who was removed',
  $$ select t.m('r_removed') = 'no membership' $$);
select t.none('[c31] ... who therefore still reads nothing', 'r_removed',
  $$ select id from public.boreholes $$);
select t.ok('[c31] ... and leaves the other members exactly as they were',
  $$ select t.m('r_kept') = 'Supervisor/active/R-2' $$);
select t.ok('[c31] ... including one who was deactivated',
  $$ select t.m('r_off') = 'Driller/deactivated/-' $$);
select t.ok('[c31] ... with the same number of organizations, memberships and policies as before it',
  $$ select (select count(*) from public.organizations) = orgs
        and (select count(*) from public.memberships) = members
        and (select count(*) from pg_policies where schemaname in ('public', 'storage')) = policies
     from t.before $$);
select t.ok('[c31] ... and exactly one organization, still',
  $$ select count(*) = 1 from public.organizations $$);

rollback;
select 'done';
