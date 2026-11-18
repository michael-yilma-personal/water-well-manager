-- Criterion 48 (RF-091) and decision 41, added in the validation of b548412.
-- Each case below went through the Drill rollback's guard with ONE clause of
-- it changed in a scratch copy, while every other check stayed green:
--
--   :case            the state                                       must
--   photo_upper      a second organization with no members and no    refuse
--                    records; one photo under its folder, the folder
--                    spelled in UPPER case. The tenancy policies take
--                    that for the organization's folder (they read
--                    the segment as a uuid), so the photo is that
--                    company's. (The guard compared the folder as
--                    text, case and all.)
--   unflagged_record no organization is marked founding; the first   refuse
--                    has every member and a borehole, the second has
--                    no members and holds one borehole. (The guard
--                    counted memberships only when no mark is there.)
--   unflagged_photo  the same, the second organization holding only  refuse
--                    a photo under its folder. (... or left photos
--                    out when no mark is there.)
--   lone_member      the founding organization is marked and holds   refuse
--   lone_record      NOTHING: no member, no record, no photo. The    refuse
--   lone_photo       second organization holds one membership, or    refuse
--                    one borehole, or one photo. Only one
--                    organization holds anything, and it is not the
--                    founding one. (The guard never read the mark
--                    and only counted organizations.)
--   unflagged_one    no organization is marked; a second one exists  run
--                    and holds nothing; the first holds the members,
--                    a borehole, a photo under its folder and a
--                    legacy photo (the Developer's reading where the
--                    criterion is silent: one pool, nothing to merge)
--
-- Run by run.sh with ON_ERROR_STOP inside a transaction that is never
-- committed. FIXTURE-READY must be printed; REACHED-END must not, except for
-- unflagged_one, where it must, after ROLLED-BACK. :rollback_drill is the
-- script's path. Names organizations.is_founding: the states cannot be
-- reached otherwise.
begin;

select id as first_org from public.organizations where is_founding \gset
select :'case' in ('photo_upper', 'unflagged_record', 'unflagged_photo', 'lone_member', 'lone_record', 'lone_photo', 'unflagged_one') as g_known,
       :'case' like 'unflagged%' as g_unflagged, :'case' like 'lone%' as g_lone,
       :'case' in ('unflagged_record', 'lone_record') as g_record,
       :'case' in ('unflagged_photo', 'lone_photo') as g_photo,
       :'case' = 'photo_upper' as g_photo_upper, :'case' = 'lone_member' as g_member \gset

insert into public.organizations (id, name)
  values ('7e57da7a-0000-4000-8000-000000000051', 'Second company (guard, more)');
insert into auth.users (id, email) values
  ('7e57da7a-0000-4000-8000-0000000000f1', 'guard51-first@db-test.invalid'),
  ('7e57da7a-0000-4000-8000-0000000000f2', 'guard51-second@db-test.invalid');
-- Account creation enrols in the founding organization; the second account
-- belongs to nothing unless the case says so.
delete from public.memberships where user_id = '7e57da7a-0000-4000-8000-0000000000f2';

alter table public.boreholes disable trigger user;

\if :g_lone
  delete from public.pipe_records;
  delete from public.drilling_events;
  delete from public.shift_logs;
  delete from public.boreholes;
  delete from public.memberships;
  -- Photos under the founding organization's folder are not removed here (the
  -- real storage schema refuses a direct delete); the check below says
  -- FIXTURE-BROKEN if the database holds one.
\else
  insert into public.boreholes (id, name, created_by, recorded_at, org_id)
    values ('7e57da7a-0000-4000-8000-0000000000f3', 'first company hole', '7e57da7a-0000-4000-8000-0000000000f1', now(), :'first_org');
\endif

\if :g_member
  insert into public.memberships (org_id, user_id, role, status)
    values ('7e57da7a-0000-4000-8000-000000000051', '7e57da7a-0000-4000-8000-0000000000f2', 'Driller', 'deactivated');
\endif
\if :g_record
  insert into public.boreholes (id, name, created_by, recorded_at, org_id)
    values ('7e57da7a-0000-4000-8000-0000000000f4', 'second company hole', '7e57da7a-0000-4000-8000-0000000000f2', now(),
            '7e57da7a-0000-4000-8000-000000000051');
\endif
\if :g_photo
  insert into storage.objects (bucket_id, name, owner)
    values ('drilling-photos', '7e57da7a-0000-4000-8000-000000000051/7e57da7a-0000-4000-8000-0000000000f2/pipe.jpg',
            '7e57da7a-0000-4000-8000-0000000000f2');
\endif
\if :g_photo_upper
  insert into storage.objects (bucket_id, name, owner)
    values ('drilling-photos', '7E57DA7A-0000-4000-8000-000000000051/7e57da7a-0000-4000-8000-0000000000f2/pipe.jpg',
            '7e57da7a-0000-4000-8000-0000000000f2');
\endif
select :'case' = 'unflagged_one' as g_one \gset
\if :g_one
  insert into storage.objects (bucket_id, name, owner) values
    ('drilling-photos', :'first_org' || '/7e57da7a-0000-4000-8000-0000000000f1/pipe.jpg', '7e57da7a-0000-4000-8000-0000000000f1'),
    ('drilling-photos', '7e57da7a-0000-4000-8000-0000000000f1/legacy.jpg', '7e57da7a-0000-4000-8000-0000000000f1');
\endif

alter table public.boreholes enable trigger user;

\if :g_unflagged
  update public.organizations set is_founding = false;
\endif

-- The state is what the case says, and nothing but it could make a guard refuse.
with held as (
  select org_id, 'record' as kind from public.boreholes
  union all select org_id, 'record' from public.pipe_records
  union all select org_id, 'record' from public.drilling_events
  union all select org_id, 'record' from public.shift_logs
  union all select org_id, 'member' from public.memberships
  union all select o.id, 'photo' from public.organizations o join storage.objects f
              on f.bucket_id = 'drilling-photos' and f.name like '%/%' and lower(split_part(f.name, '/', 1)) = o.id::text
)
select case when :'g_known'::boolean
  and (select count(*) from public.organizations) = 2
  and (select count(*) from public.organizations where is_founding) = (not :'g_unflagged'::boolean)::int
  and (select coalesce(string_agg(kind, ',' order by kind), '') from held where org_id = '7e57da7a-0000-4000-8000-000000000051')
        = case :'case' when 'photo_upper' then 'photo' when 'unflagged_record' then 'record' when 'unflagged_photo' then 'photo'
                       when 'lone_member' then 'member' when 'lone_record' then 'record' when 'lone_photo' then 'photo' else '' end
  and (:'g_lone'::boolean) = not exists (select 1 from held where org_id = :'first_org')
  and (:'g_lone'::boolean or (exists (select 1 from held where org_id = :'first_org' and kind = 'member')
                              and exists (select 1 from held where org_id = :'first_org' and kind = 'record')))
  and (not :'g_photo_upper'::boolean or not exists (
        select 1 from storage.objects where name like '7e57da7a-0000-4000-8000-000000000051/%'))
  then 'FIXTURE-READY' else 'FIXTURE-BROKEN' end;

\i :rollback_drill

select case when not exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped)
            then 'ROLLED-BACK' else 'NOT-ROLLED-BACK' end;
select 'REACHED-END';
rollback;
