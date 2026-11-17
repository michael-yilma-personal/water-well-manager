-- Rollback of 20261116010000_drill_tenancy.sql.
--
-- Puts back the policies exactly as the six pre-tenancy migrations left them
-- (they trust profiles.role through is_admin() / is_reviewer() again), then
-- drops what the migration added. Run the saas_core rollback after this one.
--
-- What is lost: org_id on every record. With records in a single organization
-- that loses nothing. Once a second organization holds records, dropping
-- org_id would MERGE the companies' records under the old global roles, so
-- the first statement below refuses to go on in that case.
--
-- profiles.role and badge_number were kept in step with the founding
-- organization's memberships by the mirroring triggers, so the old policies
-- see current roles. A role changed directly on a membership is not copied
-- back.
--
-- Grants: this restores the table and function privileges a HOSTED Supabase
-- project had before the migration (the hosted defaults, less what the
-- earlier migrations revoked), not the explicit ones the migration set. See
-- the last section.
--
-- Organizations and memberships are left in place; they belong to saas_core
-- and go with its rollback. No transaction statements: the caller wraps it.

-- ---------------------------------------------------------------------------
-- Guard: never merge two companies' records
-- ---------------------------------------------------------------------------

-- First, and before anything is changed, so that it holds even when this
-- file is not run as one transaction. Tables that have already lost org_id
-- (a rollback run twice) are skipped.
do $$
declare
  t text;
  parts text[] := '{}';
  holders bigint := 0;
begin
  foreach t in array array['boreholes', 'pipe_records', 'drilling_events', 'shift_logs']
  loop
    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'org_id'
    ) then
      parts := parts || format('select org_id from public.%I', t);
    end if;
  end loop;

  if array_length(parts, 1) > 0 then
    execute 'select count(*) from (' || array_to_string(parts, ' union ') || ') x' into holders;
  end if;

  if holders > 1 then
    raise exception 'Refusing to roll back: % organizations hold records. Dropping org_id would merge them into one pool that the pre-tenancy policies show to every reviewer.', holders;
  end if;
end
$$;

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
drop function if exists public.reads_legacy_photos_of(uuid);
drop function if exists public.uuid_or_null(text);
drop function if exists public.founding_org_id();

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
alter table if exists public.memberships drop column if exists deactivated_by_ban;
-- The founding flag (its unique index goes with the column).
alter table if exists public.organizations drop column if exists is_founding;

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
-- Grants, as a hosted project had them
-- ---------------------------------------------------------------------------
--
-- The migration replaced the default grants with explicit ones. This puts
-- back what a HOSTED Supabase project held before it: everything for the API
-- roles (the hosted default), less what 20260806010000 took away. It is wider
-- than the migrated state on purpose, because a rollback restores the previous
-- state exactly. On a database that started with no default grants (the local
-- image) this leaves more than was there before; nothing depends on that.
-- The foundation's tables keep their own grants until saas_core is rolled back.

grant all on public.profiles, public.boreholes, public.pipe_records,
  public.drilling_events, public.shift_logs
  to anon, authenticated, service_role;

revoke delete on public.boreholes, public.pipe_records,
  public.drilling_events, public.shift_logs
  from anon, authenticated;

-- Table-level UPDATE goes (which also clears the column grant), then the two
-- editable columns come back: role is not self-editable.
revoke update, delete on public.profiles from anon, authenticated;
grant update (name, badge_number) on public.profiles to authenticated;

-- The migration took is_admin() and is_reviewer() away from signed-out
-- clients. The restored policies apply to every role and call them, so they
-- go back to everyone, which is also what a hosted project had.
grant execute on function public.is_admin(), public.is_reviewer()
  to public, anon, authenticated, service_role;
