-- Criterion 48 (RF-091): the state in which the Drill rollback must refuse
-- although NO organization but the founding one has a member.
--
-- A second organization exists. Its members were removed; something of it is
-- still stored. After the rollback the pre-tenancy policies know no
-- organizations, so that company's rows or photos would join the one pool
-- every Supervisor and Administrator of the founding company reads.
--
-- psql variables:
--   what            boreholes | pipe_records | drilling_events | shift_logs:
--                     the second organization holds exactly ONE row, in that
--                     table, and nothing in the other three and no photo.
--                     (A child row then belongs to a borehole of the founding
--                     organization. With founding_empty there is no such
--                     borehole: the second organization then holds the row's
--                     borehole as well, two rows in all.)
--                   photo:  it holds no row at all; one object is stored under
--                     drilling-photos/<its id>/<user id>/
--                   nothing: it holds nothing (the rollback must run). The
--                     founding organization then also has a photo under its
--                     own folder, <founding id>/<user id>/, and one under the
--                     legacy path
--   founding_empty  1: the founding organization holds no record row either
--                      (whatever the database held is removed)
--                   0: it holds at least one row in every one of the four
--
-- Loaded committed by supabase/tests/local.sh into a copy of a scratch
-- database, and inside a transaction that is never committed by
-- guards/rollback_refuses_c48.sql (run.sh). Prints FIXTURE-READY when the
-- state is what the case says, FIXTURE-BROKEN otherwise.
--
-- Rows are written by the role applying the rollback with the record tables'
-- own triggers switched off for the moment (ALTER TABLE ... DISABLE TRIGGER
-- USER, which the tables' owner may do; foreign keys stay checked): a child
-- row always takes its borehole's organization (criterion 8), so a child row
-- of the second organization under a borehole of the founding one cannot be
-- made otherwise. The guard must not lean on that: it is asked about every
-- table on its own.

insert into public.organizations (id, name)
  values ('7e57da7a-0000-4000-8000-000000000048', 'Second company (no members)');
insert into auth.users (id, email) values
  ('7e57da7a-0000-4000-8000-0000000000c1', 'guard48-founding@db-test.invalid'),
  ('7e57da7a-0000-4000-8000-0000000000c2', 'guard48-former@db-test.invalid');
-- The former member of the second company belongs to nothing any more.
delete from public.memberships where user_id = '7e57da7a-0000-4000-8000-0000000000c2';

alter table public.boreholes       disable trigger user;
alter table public.pipe_records    disable trigger user;
alter table public.drilling_events disable trigger user;
alter table public.shift_logs      disable trigger user;

select :'founding_empty' = '1' as c48_founding_empty \gset
\if :c48_founding_empty
  delete from public.pipe_records;
  delete from public.drilling_events;
  delete from public.shift_logs;
  delete from public.boreholes;
\else
  insert into public.boreholes (id, name, created_by, recorded_at, org_id)
    select '7e57da7a-0000-4000-8000-0000000000d1', 'founding hole', '7e57da7a-0000-4000-8000-0000000000c1', now(), id
    from public.organizations where id <> '7e57da7a-0000-4000-8000-000000000048';
  insert into public.pipe_records (id, borehole_id, pipe_number, created_by, recorded_at, org_id)
    select '7e57da7a-0000-4000-8000-0000000000d2', '7e57da7a-0000-4000-8000-0000000000d1', 1, '7e57da7a-0000-4000-8000-0000000000c1', now(), id
    from public.organizations where id <> '7e57da7a-0000-4000-8000-000000000048';
  insert into public.drilling_events (id, borehole_id, created_by, recorded_at, org_id)
    select '7e57da7a-0000-4000-8000-0000000000d3', '7e57da7a-0000-4000-8000-0000000000d1', '7e57da7a-0000-4000-8000-0000000000c1', now(), id
    from public.organizations where id <> '7e57da7a-0000-4000-8000-000000000048';
  insert into public.shift_logs (id, borehole_id, created_by, recorded_at, org_id)
    select '7e57da7a-0000-4000-8000-0000000000d4', '7e57da7a-0000-4000-8000-0000000000d1', '7e57da7a-0000-4000-8000-0000000000c1', now(), id
    from public.organizations where id <> '7e57da7a-0000-4000-8000-000000000048';
\endif

-- The one thing the second organization still holds. A child row names the
-- founding organization's borehole when there is one; with founding_empty
-- there is none, and the second organization holds the child's borehole too.
select :'what' in ('pipe_records', 'drilling_events', 'shift_logs') and :'founding_empty' = '1' as c48_own_hole \gset
\if :c48_own_hole
  insert into public.boreholes (id, name, created_by, recorded_at, org_id)
    values ('7e57da7a-0000-4000-8000-0000000000d1', 'second company hole', '7e57da7a-0000-4000-8000-0000000000c2', now(),
            '7e57da7a-0000-4000-8000-000000000048');
\endif
select :'what' = 'boreholes' as c48_boreholes, :'what' = 'pipe_records' as c48_pipes,
       :'what' = 'drilling_events' as c48_events, :'what' = 'shift_logs' as c48_logs,
       :'what' = 'photo' as c48_photo, :'what' = 'nothing' as c48_nothing \gset
\if :c48_boreholes
  insert into public.boreholes (id, name, created_by, recorded_at, org_id)
    values ('7e57da7a-0000-4000-8000-0000000000e1', 'second company hole', '7e57da7a-0000-4000-8000-0000000000c2', now(),
            '7e57da7a-0000-4000-8000-000000000048');
\endif
\if :c48_pipes
  insert into public.pipe_records (id, borehole_id, pipe_number, created_by, recorded_at, org_id)
    values ('7e57da7a-0000-4000-8000-0000000000e2', '7e57da7a-0000-4000-8000-0000000000d1', 2, '7e57da7a-0000-4000-8000-0000000000c2', now(),
            '7e57da7a-0000-4000-8000-000000000048');
\endif
\if :c48_events
  insert into public.drilling_events (id, borehole_id, created_by, recorded_at, org_id)
    values ('7e57da7a-0000-4000-8000-0000000000e3', '7e57da7a-0000-4000-8000-0000000000d1', '7e57da7a-0000-4000-8000-0000000000c2', now(),
            '7e57da7a-0000-4000-8000-000000000048');
\endif
\if :c48_logs
  insert into public.shift_logs (id, borehole_id, created_by, recorded_at, org_id)
    values ('7e57da7a-0000-4000-8000-0000000000e4', '7e57da7a-0000-4000-8000-0000000000d1', '7e57da7a-0000-4000-8000-0000000000c2', now(),
            '7e57da7a-0000-4000-8000-000000000048');
\endif
\if :c48_photo
  insert into storage.objects (bucket_id, name, owner)
    values ('drilling-photos',
            '7e57da7a-0000-4000-8000-000000000048/7e57da7a-0000-4000-8000-0000000000c2/pipe.jpg',
            '7e57da7a-0000-4000-8000-0000000000c2');
\endif
\if :c48_nothing
  insert into storage.objects (bucket_id, name, owner)
    select 'drilling-photos', id || '/7e57da7a-0000-4000-8000-0000000000c1/pipe.jpg', '7e57da7a-0000-4000-8000-0000000000c1'
    from public.organizations where id <> '7e57da7a-0000-4000-8000-000000000048';
  insert into storage.objects (bucket_id, name, owner)
    values ('drilling-photos', '7e57da7a-0000-4000-8000-0000000000c1/legacy.jpg', '7e57da7a-0000-4000-8000-0000000000c1');
\endif

alter table public.boreholes       enable trigger user;
alter table public.pipe_records    enable trigger user;
alter table public.drilling_events enable trigger user;
alter table public.shift_logs      enable trigger user;

-- The state is what the case says, and nothing but it could make a guard refuse.
select case when
      (select count(*) from public.organizations) = 2
  and not exists (select 1 from public.memberships where org_id = '7e57da7a-0000-4000-8000-000000000048')
  and (select count(*) from public.boreholes       where org_id = '7e57da7a-0000-4000-8000-000000000048')
        = (:'what' = 'boreholes' or (:'what' in ('pipe_records', 'drilling_events', 'shift_logs') and :'founding_empty' = '1'))::int
  and (select count(*) from public.pipe_records    where org_id = '7e57da7a-0000-4000-8000-000000000048') = (:'what' = 'pipe_records')::int
  and (select count(*) from public.drilling_events where org_id = '7e57da7a-0000-4000-8000-000000000048') = (:'what' = 'drilling_events')::int
  and (select count(*) from public.shift_logs      where org_id = '7e57da7a-0000-4000-8000-000000000048') = (:'what' = 'shift_logs')::int
  and (select count(*) from storage.objects
       where bucket_id = 'drilling-photos' and name like '7e57da7a-0000-4000-8000-000000000048/%') = (:'what' = 'photo')::int
  and (:'founding_empty' = '1') = (
        not exists (select 1 from public.boreholes       where org_id <> '7e57da7a-0000-4000-8000-000000000048')
    and not exists (select 1 from public.pipe_records    where org_id <> '7e57da7a-0000-4000-8000-000000000048')
    and not exists (select 1 from public.drilling_events where org_id <> '7e57da7a-0000-4000-8000-000000000048')
    and not exists (select 1 from public.shift_logs      where org_id <> '7e57da7a-0000-4000-8000-000000000048'))
  and (:'founding_empty' = '1') <> (
        exists (select 1 from public.boreholes       where org_id <> '7e57da7a-0000-4000-8000-000000000048')
    and exists (select 1 from public.pipe_records    where org_id <> '7e57da7a-0000-4000-8000-000000000048')
    and exists (select 1 from public.drilling_events where org_id <> '7e57da7a-0000-4000-8000-000000000048')
    and exists (select 1 from public.shift_logs      where org_id <> '7e57da7a-0000-4000-8000-000000000048'))
  then 'FIXTURE-READY' else 'FIXTURE-BROKEN' end;
