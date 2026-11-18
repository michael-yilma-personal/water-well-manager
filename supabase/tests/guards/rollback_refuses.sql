-- Decision 31: the Drill rollback raises, and changes nothing, when more than
-- one organization holds record rows: dropping org_id would merge two
-- companies' records into one pool that the pre-tenancy policies show to
-- every reviewer.
--
-- Run by run.sh with ON_ERROR_STOP, so psql leaves at the first error and the
-- open transaction is rolled back by the server. run.sh reads the markers:
-- FIXTURE-READY must be printed, REACHED-END must not. :rollback_drill is the
-- script's path.
begin;

insert into public.organizations (id, name) values ('7e57da7a-0000-4000-8000-000000000002', 'Second company');
insert into auth.users (id, email) values ('7e57da7a-0000-4000-8000-0000000000a1', 'guard1@db-test.invalid');
insert into public.boreholes (id, name, created_by, recorded_at, org_id)
  select '7e57da7a-0000-4000-8000-0000000000b1', 'first company hole', '7e57da7a-0000-4000-8000-0000000000a1', now(), id
  from public.organizations where id <> '7e57da7a-0000-4000-8000-000000000002';
insert into public.boreholes (id, name, created_by, recorded_at, org_id)
  values ('7e57da7a-0000-4000-8000-0000000000b2', 'second company hole', '7e57da7a-0000-4000-8000-0000000000a1', now(),
          '7e57da7a-0000-4000-8000-000000000002');

select case when count(distinct org_id) >= 2 then 'FIXTURE-READY' else 'FIXTURE-BROKEN' end from public.boreholes;

\i :rollback_drill

select 'REACHED-END';
rollback;
