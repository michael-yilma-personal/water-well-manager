-- A second organization that has one membership and no records, committed.
-- Loaded by supabase/tests/local.sh into a scratch database before it tries
-- the Drill rollback there (decision 41). guards/rollback_refuses_members.sql
-- builds the same thing inside a transaction for run.sh, with an active
-- membership; this one is DEACTIVATED: decision 41 says "has a membership",
-- whatever its status.
insert into public.organizations (id, name) values ('7e57da7a-0000-4000-8000-000000000004', 'Second company (members only)');
insert into auth.users (id, email) values ('7e57da7a-0000-4000-8000-0000000000a4', 'guard4@db-test.invalid');
delete from public.memberships where user_id = '7e57da7a-0000-4000-8000-0000000000a4';
insert into public.memberships (org_id, user_id, role, status)
  values ('7e57da7a-0000-4000-8000-000000000004', '7e57da7a-0000-4000-8000-0000000000a4', 'Driller', 'deactivated');
-- The founding organization holds a record, so exactly ONE organization does.
insert into auth.users (id, email) values ('7e57da7a-0000-4000-8000-0000000000a5', 'guard5@db-test.invalid');
insert into public.boreholes (id, name, created_by, recorded_at, org_id)
  select '7e57da7a-0000-4000-8000-0000000000b5', 'first company hole', '7e57da7a-0000-4000-8000-0000000000a5', now(), id
  from public.organizations where id <> '7e57da7a-0000-4000-8000-000000000004';
