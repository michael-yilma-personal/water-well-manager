-- Decisions 27 and 30 rest on the migration knowing which organization is the
-- founding one. On its first application it marks the only organization, or
-- creates one. With SEVERAL organizations and none marked there is nothing to
-- tell them apart by, and a guess would hand the pre-tenancy accounts, records
-- and photos to whichever company it picked: it must raise instead.
--
-- That state is rebuilt here by taking the mark off (this names
-- organizations.is_founding; there is no other way to reach the guard) and
-- adding a second organization, inside a transaction that is never committed.
--
-- Run by run.sh with ON_ERROR_STOP, so psql leaves at the first error and the
-- open transaction is rolled back by the server. run.sh reads the markers:
-- FIXTURE-READY must be printed, REACHED-END must not. :mig_drill is the
-- migration's path.
begin;

update public.organizations set is_founding = false;
insert into public.organizations (id, name, created_at)
  values ('7e57da7a-0000-4000-8000-000000000003', 'Second company (first run)', timestamptz '2000-01-01 00:00:00+00');

select case when count(*) >= 2 and not bool_or(is_founding) then 'FIXTURE-READY' else 'FIXTURE-BROKEN' end
from public.organizations;

\i :mig_drill

select 'REACHED-END';
rollback;
