-- Criterion 53 (RF-098), for run.sh: the Drill rollback refuses, and changes
-- nothing, when a stored photo has the shape of the new path
-- (<uuid>/<uuid>/...) and its first segment is not the founding organization's
-- id, ALSO when no organization with that id exists (any more). A legacy path
-- (<user id>/<file>) never stops it.
--
--   :case          the state                                          must
--   orphan         one organization, marked founding, with members    refuse
--                  and a borehole. One photo in the photos bucket at
--                  <uuid>/<uuid>/pipe.jpg whose first segment is the
--                  id of NO organization.
--   orphan_upper   the same, the first segment spelled in UPPER case  refuse
--   orphan_deep    the same (lower case), the file two folders        refuse
--                  further down: <uuid>/<uuid>/a/b/pipe.jpg
--   legacy         the same organization; the only photos are         run
--                    <user id>/legacy.jpg      of a member
--                    <user id>/legacy.jpg      of an account that no
--                                              longer exists
--                    <user id>/<uuid>          a legacy photo whose
--                                              FILE NAME is a uuid
--                                              (two segments: not the
--                                              new shape)
--                    <founding>/<user id>/pipe.jpg   new path, under
--                                              the founding
--                                              organization
--   founding_upper the same organization; the only photo is a new     run
--                  path under the founding organization's id spelled
--                  in UPPER case. (The tenancy policies read the
--                  segment as a uuid, so that IS the founding
--                  organization's folder: the same reading that makes
--                  orphan_upper and c48's photo_upper refuse.)
--
-- Run by run.sh with ON_ERROR_STOP inside a transaction that is never
-- committed. FIXTURE-READY must be printed; REACHED-END must not, except for
-- legacy and founding_upper, where it must, after ROLLED-BACK.
-- :rollback_drill is the script's path.
begin;

select id as first_org from public.organizations where is_founding \gset
select :'case' in ('orphan', 'orphan_upper', 'orphan_deep', 'legacy', 'founding_upper') as g_known,
       :'case' = 'orphan' as g_orphan, :'case' = 'orphan_upper' as g_orphan_upper, :'case' = 'orphan_deep' as g_orphan_deep,
       :'case' = 'legacy' as g_legacy, :'case' = 'founding_upper' as g_founding_upper \gset

-- Two accounts; account creation enrols both in the founding organization.
insert into auth.users (id, email) values
  ('7e57da7a-0000-4000-8000-000000005301', 'guard53-first@db-test.invalid'),
  ('7e57da7a-0000-4000-8000-000000005302', 'guard53-second@db-test.invalid');

alter table public.boreholes disable trigger user;
insert into public.boreholes (id, name, created_by, recorded_at, org_id)
  values ('7e57da7a-0000-4000-8000-000000005303', 'founding company hole (guard 53)', '7e57da7a-0000-4000-8000-000000005301', now(), :'first_org');
alter table public.boreholes enable trigger user;

-- 7e57da7a-0000-4000-8000-0000000053dd is the id of no organization;
-- 7e57da7a-0000-4000-8000-0000000053ee is the id of no account.
\if :g_orphan
  insert into storage.objects (bucket_id, name, owner)
    values ('drilling-photos', '7e57da7a-0000-4000-8000-0000000053dd/7e57da7a-0000-4000-8000-000000005302/pipe.jpg',
            '7e57da7a-0000-4000-8000-000000005302');
\endif
\if :g_orphan_upper
  insert into storage.objects (bucket_id, name, owner)
    values ('drilling-photos', '7E57DA7A-0000-4000-8000-0000000053DD/7e57da7a-0000-4000-8000-000000005302/pipe.jpg',
            '7e57da7a-0000-4000-8000-000000005302');
\endif
\if :g_orphan_deep
  insert into storage.objects (bucket_id, name, owner)
    values ('drilling-photos', '7e57da7a-0000-4000-8000-0000000053dd/7e57da7a-0000-4000-8000-000000005302/a/b/pipe.jpg',
            '7e57da7a-0000-4000-8000-000000005302');
\endif
\if :g_legacy
  insert into storage.objects (bucket_id, name, owner) values
    ('drilling-photos', '7e57da7a-0000-4000-8000-000000005301/legacy.jpg', '7e57da7a-0000-4000-8000-000000005301'),
    ('drilling-photos', '7e57da7a-0000-4000-8000-0000000053ee/legacy.jpg', null),
    ('drilling-photos', '7e57da7a-0000-4000-8000-000000005301/7e57da7a-0000-4000-8000-0000000053aa', '7e57da7a-0000-4000-8000-000000005301'),
    ('drilling-photos', :'first_org' || '/7e57da7a-0000-4000-8000-000000005301/pipe.jpg', '7e57da7a-0000-4000-8000-000000005301');
\endif
\if :g_founding_upper
  insert into storage.objects (bucket_id, name, owner)
    values ('drilling-photos', upper(:'first_org') || '/7e57da7a-0000-4000-8000-000000005301/pipe.jpg', '7e57da7a-0000-4000-8000-000000005301');
\endif

-- The state is what the case says, and nothing but the photo could make a
-- guard refuse: one organization, marked; every membership and every record
-- row is the founding organization's; no account or organization carries the
-- ids the photos name.
with rec as (
  select org_id from public.boreholes
  union all select org_id from public.pipe_records
  union all select org_id from public.drilling_events
  union all select org_id from public.shift_logs
  union all select org_id from public.memberships
), photo as (
  select name, lower(split_part(name, '/', 1)) as seg1 from storage.objects where bucket_id = 'drilling-photos'
), uu as (select '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.' as new_shape)
select case when :'g_known'::boolean
  and (select count(*) from public.organizations) = 1
  and (select count(*) from public.organizations where is_founding) = 1
  and not exists (select 1 from rec where org_id is distinct from :'first_org')
  and exists (select 1 from public.memberships where org_id = :'first_org' and user_id = '7e57da7a-0000-4000-8000-000000005301')
  and exists (select 1 from public.boreholes where org_id = :'first_org')
  and not exists (select 1 from public.organizations where id in ('7e57da7a-0000-4000-8000-0000000053dd', '7e57da7a-0000-4000-8000-0000000053ee'))
  and not exists (select 1 from auth.users where id in ('7e57da7a-0000-4000-8000-0000000053dd', '7e57da7a-0000-4000-8000-0000000053ee'))
  -- photos of the new shape outside the founding organization: one in the refusing cases, none otherwise
  and (select count(*) from photo, uu where lower(name) ~ new_shape and seg1 <> :'first_org')
        = (:'g_orphan'::boolean or :'g_orphan_upper'::boolean or :'g_orphan_deep'::boolean)::int
  and (not :'g_orphan_upper'::boolean or not exists (select 1 from storage.objects where name like '7e57da7a-0000-4000-8000-0000000053dd/%'))
  and (not :'g_founding_upper'::boolean or (:'first_org' <> upper(:'first_org')
        and not exists (select 1 from storage.objects where bucket_id = 'drilling-photos' and name like :'first_org' || '/%')
        and exists (select 1 from storage.objects where bucket_id = 'drilling-photos' and name like upper(:'first_org') || '/%')))
  and (not :'g_legacy'::boolean or (
        (select count(*) from photo, uu where name like '7e57da7a-0000-4000-8000-0000000053%' and lower(name) !~ new_shape) = 3
        and (select count(*) from photo, uu where lower(name) ~ new_shape and seg1 = :'first_org') >= 1))
  then 'FIXTURE-READY' else 'FIXTURE-BROKEN' end;

\i :rollback_drill

select case when not exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped)
            then 'ROLLED-BACK' else 'NOT-ROLLED-BACK' end;
select 'REACHED-END';
rollback;
