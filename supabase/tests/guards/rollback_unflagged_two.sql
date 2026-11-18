-- Decision 41 (RF-081), the case with no organization marked founding: the
-- flag column is there (the migration is in force) but no organization
-- carries the mark, and TWO organizations have members. Nothing says which
-- of them the pre-tenancy pool is, and the other company's members would
-- join it: the Drill rollback must raise, and change nothing.
--
-- Added in the validation of f1aabbe: with the guard reduced to "an
-- organization is marked and another has members", nothing else failed.
-- Neither organization holds a second organization's records, so the older
-- guard (decision 31) is not what stops the script. This names
-- organizations.is_founding; the state cannot be reached otherwise.
--
-- Run by run.sh with ON_ERROR_STOP, so psql leaves at the first error and the
-- open transaction is rolled back by the server. run.sh reads the markers:
-- FIXTURE-READY must be printed, REACHED-END must not. :rollback_drill is the
-- script's path.
begin;

insert into public.organizations (id, name) values ('7e57da7a-0000-4000-8000-000000000006', 'Second company (no mark)');
insert into auth.users (id, email) values
  ('7e57da7a-0000-4000-8000-0000000000a6', 'guard6@db-test.invalid'),
  ('7e57da7a-0000-4000-8000-0000000000a7', 'guard7@db-test.invalid');
-- guard6 stays where account creation put it, in the first organization;
-- guard7 belongs to the second company only.
delete from public.memberships where user_id = '7e57da7a-0000-4000-8000-0000000000a7';
insert into public.memberships (org_id, user_id, role, status)
  values ('7e57da7a-0000-4000-8000-000000000006', '7e57da7a-0000-4000-8000-0000000000a7', 'Administrator', 'active');

update public.organizations set is_founding = false;

select case when not exists (select 1 from public.organizations where is_founding)
             and (select count(distinct org_id) from public.memberships) = 2
             and (select count(*) from (select org_id from public.boreholes union select org_id from public.pipe_records
                                        union select org_id from public.drilling_events union select org_id from public.shift_logs) r) <= 1
            then 'FIXTURE-READY' else 'FIXTURE-BROKEN' end;

\i :rollback_drill

select 'REACHED-END';
rollback;
