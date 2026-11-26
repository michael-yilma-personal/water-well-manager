-- Subscriptions for Drill: the organization's access level (org_access(), from
-- saas_subscriptions) decides whether its records and photos can be written
-- and read.
--
--   full        as before
--   read_only   everything readable stays readable; no record is inserted or
--               updated, no photo uploaded
--   none        nothing of the organization's records or photos is read either
--
-- A record write refused for the subscription raises SQLSTATE SS002, so that
-- an app can keep the record and send it again after renewal; an ordinary
-- permission refusal is still 42501. A refused photo upload is 42501.
--
-- Nothing of drill_tenancy is rewritten: this file only adds to it (a trigger
-- and a restrictive policy per record table, two restrictive policies on the
-- photo bucket), so drill_tenancy can be applied again on top and each
-- rollback takes away its own.
--
-- Installed builds (1.1.7) are not changed: SS002 is an error they retry and
-- then park, and "retry parked" sends the record after renewal.
--
-- Re-runnable. Rollback: supabase/rollback/20261125010000_drill_subscriptions.sql.

-- ---------------------------------------------------------------------------
-- 1. Functions
-- ---------------------------------------------------------------------------
--
-- Created together with their grants inside one DO block, which is one
-- statement (see saas_members for why).
do $do$
begin
  -- Refuses the write with SS002 unless the row's organization has full
  -- access. It binds whoever the row level security policies bind (the API's
  -- signed-in users), not the service role or a migration. Not security
  -- definer: it must see who is writing.
  create or replace function public.subscription_write_guard()
  returns trigger
  language plpgsql
  set search_path = public
  as $fn$
  begin
    if row_security_active(tg_relid) and public.org_access(new.org_id) <> 'full' then
      raise exception 'The organization''s subscription does not allow changes.'
        using errcode = 'SS002';
    end if;
    return new;
  end
  $fn$;

  -- The access level of the organization a photo's path belongs to:
  -- <org_id>/... is that organization's, also with one segment; any other
  -- one-segment path is the legacy <user_id>/<file>, the founding
  -- organization's. Anything else belongs to none. It answers only an active
  -- member of that organization (the policies of drill_tenancy let nobody
  -- else in anyway); everyone else is told 'none'.
  create or replace function public.drilling_photo_access(name text)
  returns text
  language sql
  stable
  security definer
  set search_path = public
  as $fn$
    select case when public.is_org_member(p.org) then public.org_access(p.org) else 'none' end
    from (
      select case
               when array_length(storage.foldername(name), 1) = 1
                    and not exists (
                      select 1 from public.organizations o
                      -- The function's name in front: organizations has a
                      -- column called name too.
                      where o.id = public.uuid_or_null(
                        (storage.foldername(drilling_photo_access.name))[1]))
               then public.founding_org_id()
               else public.uuid_or_null((storage.foldername(name))[1])
             end as org
    ) p;
  $fn$;

  revoke execute on function public.subscription_write_guard()
    from public, anon, authenticated;
  revoke execute on function public.drilling_photo_access(text) from public, anon;
  grant execute on function public.drilling_photo_access(text) to authenticated, service_role;
end
$do$;

-- ---------------------------------------------------------------------------
-- 2. Records
-- ---------------------------------------------------------------------------
--
-- Writes: a trigger, because a policy can only answer 42501. Its name sorts
-- after <table>_org_guard, which decides the row's organization first.
-- Reads: a restrictive policy, which narrows the policies of drill_tenancy.
do $do$
declare
  t text;
begin
  foreach t in array array['boreholes', 'pipe_records', 'drilling_events', 'shift_logs']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_subscription_guard', t);
    execute format(
      'create trigger %I before insert or update on public.%I '
      'for each row execute function public.subscription_write_guard()',
      t || '_subscription_guard', t);

    execute format('drop policy if exists %I on public.%I', t || '_subscription', t);
    execute format(
      'create policy %I on public.%I as restrictive for select to authenticated '
      'using (public.org_access(org_id) <> ''none'')',
      t || '_subscription', t);
  end loop;
end
$do$;

-- ---------------------------------------------------------------------------
-- 3. Photos
-- ---------------------------------------------------------------------------
--
-- Restrictive policies on storage.objects apply to every bucket, so each
-- lets any other bucket through.
do $do$
begin
  drop policy if exists drilling_photos_subscription_insert on storage.objects;
  create policy drilling_photos_subscription_insert on storage.objects
    as restrictive for insert to authenticated
    with check (
      bucket_id is distinct from 'drilling-photos'
      or public.drilling_photo_access(name) = 'full'
    );

  drop policy if exists drilling_photos_subscription_select on storage.objects;
  create policy drilling_photos_subscription_select on storage.objects
    as restrictive for select to authenticated
    using (
      bucket_id is distinct from 'drilling-photos'
      or public.drilling_photo_access(name) <> 'none'
    );
end
$do$;
