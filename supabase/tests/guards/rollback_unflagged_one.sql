-- The other side of guards/rollback_unflagged_two.sql, and the Developer's
-- reading where decision 41 is silent: no organization is marked founding,
-- a second organization exists, and only ONE organization has members. There
-- is one pool of people and nobody to merge into it, so the Drill rollback
-- runs. (A guard that refused whenever any unmarked organization has members
-- would make the rollback impossible exactly when the mark has been lost.)
--
-- Run by run.sh with ON_ERROR_STOP inside a transaction that is rolled back.
-- Here REACHED-END MUST be printed. :rollback_drill is the script's path.
begin;

insert into public.organizations (id, name) values ('7e57da7a-0000-4000-8000-000000000008', 'Second company (no mark, empty)');
insert into auth.users (id, email) values ('7e57da7a-0000-4000-8000-0000000000a8', 'guard8@db-test.invalid');

update public.organizations set is_founding = false;

select case when not exists (select 1 from public.organizations where is_founding)
             and (select count(*) from public.organizations) = 2
             and (select count(distinct org_id) from public.memberships) = 1
             and not exists (select 1 from public.memberships where org_id = '7e57da7a-0000-4000-8000-000000000008')
            then 'FIXTURE-READY' else 'FIXTURE-BROKEN' end;

\i :rollback_drill

select case when not exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped)
            then 'ROLLED-BACK' else 'NOT-ROLLED-BACK' end;
select 'REACHED-END';
rollback;
