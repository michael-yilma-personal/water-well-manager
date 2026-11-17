-- Rollback of 20261116010000_drill_tenancy.sql.
--
-- Puts back the policies exactly as the six pre-tenancy migrations left them
-- (they trust profiles.role through is_admin() / is_reviewer() again), then
-- drops what the migration added. Run the saas_core rollback after this one.
--
-- What is lost: org_id on every record. With a single organization that loses
-- nothing; once a second organization holds data, rolling back would MERGE
-- the organizations' records under the old global roles. Do not run it then.
--
-- profiles.role and badge_number were kept in step by the mirroring triggers
-- for accounts with one membership, so the old policies see current roles. A
-- role changed directly on a membership is not copied back.
--
-- Organizations and memberships are left in place; they belong to saas_core
-- and go with its rollback. No transaction statements: the caller wraps it.

-- ---------------------------------------------------------------------------
-- Policies, as they were
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['boreholes', 'pipe_records', 'drilling_events', 'shift_logs']
  loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format(
      'create policy %I_select on public.%I for select '
      'using (created_by = auth.uid() or public.is_reviewer())',
      t, t);

    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format(
      'create policy %I_insert on public.%I for insert '
      'with check (created_by = auth.uid() and not public.is_admin())',
      t, t);

    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format(
      'create policy %I_update on public.%I for update '
      'using (created_by = auth.uid() and not public.is_admin()) '
      'with check (created_by = auth.uid() and not public.is_admin())',
      t, t);
  end loop;
end
$$;

drop policy if exists pipe_records_update on public.pipe_records;
create policy pipe_records_update on public.pipe_records
  for update
  using ((created_by = auth.uid() and not public.is_admin()) or public.is_reviewer())
  with check ((created_by = auth.uid() and not public.is_admin()) or public.is_reviewer());

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (id = auth.uid() or public.is_reviewer());

drop policy if exists drilling_photos_insert on storage.objects;
create policy drilling_photos_insert on storage.objects
  for insert with check (
    bucket_id = 'drilling-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists drilling_photos_select on storage.objects;
create policy drilling_photos_select on storage.objects
  for select using (
    bucket_id = 'drilling-photos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin())
  );

-- ---------------------------------------------------------------------------
-- Triggers and functions the migration added
-- ---------------------------------------------------------------------------

drop trigger if exists on_auth_user_ban_changed on auth.users;
drop trigger if exists profiles_mirror_membership on public.profiles;
drop trigger if exists boreholes_org_guard on public.boreholes;
drop trigger if exists pipe_records_org_guard on public.pipe_records;
drop trigger if exists drilling_events_org_guard on public.drilling_events;
drop trigger if exists shift_logs_org_guard on public.shift_logs;

drop function if exists public.mirror_ban_to_membership();
drop function if exists public.mirror_profile_to_membership();
drop function if exists public.boreholes_org_guard();
drop function if exists public.borehole_child_org_guard();
drop function if exists public.shares_org_as(uuid, text[]);
drop function if exists public.uuid_or_null(text);

-- ---------------------------------------------------------------------------
-- org_id (its index and foreign key go with the column)
-- ---------------------------------------------------------------------------

alter table public.boreholes       drop column if exists org_id;
alter table public.pipe_records    drop column if exists org_id;
alter table public.drilling_events drop column if exists org_id;
alter table public.shift_logs      drop column if exists org_id;

-- ---------------------------------------------------------------------------
-- The foundation back to its defaults
-- ---------------------------------------------------------------------------

alter table if exists public.memberships drop constraint if exists memberships_role_check;

-- Only while the foundation is still there; otherwise this would leave a
-- stray function behind.
do $$
begin
  if to_regprocedure('public.saas_admin_roles()') is not null then
    execute $f$
      create or replace function public.saas_admin_roles()
      returns text[]
      language sql
      stable
      security definer
      set search_path = public
      as $body$ select array['admin'] $body$
    $f$;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Grants, as they were
-- ---------------------------------------------------------------------------

-- The migration revoked TRUNCATE from the client roles on every table. This
-- returns it on the five pre-tenancy tables only because a rollback restores
-- the previous state exactly; the foundation's tables stay revoked.
grant truncate on public.profiles, public.boreholes, public.pipe_records,
  public.drilling_events, public.shift_logs
  to anon, authenticated;
