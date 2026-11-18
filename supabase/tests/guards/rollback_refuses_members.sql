-- Decision 41 (RF-081): the Drill rollback also raises, and changes nothing,
-- when an organization other than the founding one has a MEMBERSHIP, even
-- though it holds no records. After the rollback the pre-tenancy policies
-- know no organizations: that company's member would become a member of the
-- one pool, and its Administrator an Administrator of everything.
--
-- The second organization here has one active member and not a single row in
-- any record table, so the older guard (decision 31, two organizations
-- holding records) is not what stops the script.
--
-- Run by run.sh with ON_ERROR_STOP, so psql leaves at the first error and the
-- open transaction is rolled back by the server. run.sh reads the markers:
-- FIXTURE-READY must be printed, REACHED-END must not. :rollback_drill is the
-- script's path.
begin;

insert into public.organizations (id, name) values ('7e57da7a-0000-4000-8000-000000000004', 'Second company (members only)');
insert into auth.users (id, email) values ('7e57da7a-0000-4000-8000-0000000000a4', 'guard4@db-test.invalid');
-- A new account is enrolled in the founding organization (decision 27); this
-- one belongs to the second company and to nothing else.
delete from public.memberships where user_id = '7e57da7a-0000-4000-8000-0000000000a4';
insert into public.memberships (org_id, user_id, role, status)
  values ('7e57da7a-0000-4000-8000-000000000004', '7e57da7a-0000-4000-8000-0000000000a4', 'Administrator', 'active');

-- The founding organization holds a record, so exactly ONE organization does.
insert into auth.users (id, email) values ('7e57da7a-0000-4000-8000-0000000000a5', 'guard5@db-test.invalid');
insert into public.boreholes (id, name, created_by, recorded_at, org_id)
  select '7e57da7a-0000-4000-8000-0000000000b5', 'first company hole', '7e57da7a-0000-4000-8000-0000000000a5', now(), id
  from public.organizations where id <> '7e57da7a-0000-4000-8000-000000000004';

select case when (select count(*) from public.memberships where org_id = '7e57da7a-0000-4000-8000-000000000004') = 1
             and (select count(*) from (select org_id from public.boreholes union select org_id from public.pipe_records
                                        union select org_id from public.drilling_events union select org_id from public.shift_logs) r) = 1
             and not exists (select 1 from public.boreholes where org_id = '7e57da7a-0000-4000-8000-000000000004')
            then 'FIXTURE-READY' else 'FIXTURE-BROKEN' end;

\i :rollback_drill

select 'REACHED-END';
rollback;
