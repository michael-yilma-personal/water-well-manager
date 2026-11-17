-- Tenancy for Drill: every record belongs to an organization, and every
-- policy asks about the caller's membership of THAT organization instead of
-- the single global profiles.role.
--
-- Installed builds (1.1.7), the current dashboard and the admin-users Edge
-- Function know nothing about organizations and are not changed here:
--   - they send no org_id: triggers fill it in (section 4);
--   - they read and write profiles.role and badge_number, and ban accounts:
--     triggers mirror that into the membership (section 5);
--   - they store photos under <user_id>/<file>: still accepted (section 8).
--
-- Existing data moves into one founding organization. Nothing about an
-- existing row changes except that it gains org_id; in particular
-- modified_at does not move, or every device would download everything again.
--
-- Rollback: supabase/rollback/20261116010000_drill_tenancy.sql.

-- ---------------------------------------------------------------------------
-- 1. Drill's role vocabulary
-- ---------------------------------------------------------------------------

-- Replaces the foundation's default ('admin').
create or replace function public.saas_admin_roles()
returns text[]
language sql
stable
security definer
set search_path = public
as $$ select array['Administrator'] $$;

alter table public.memberships drop constraint if exists memberships_role_check;
alter table public.memberships
  add constraint memberships_role_check
  check (role in ('Driller', 'Data Logger', 'Supervisor', 'Administrator'));

-- ---------------------------------------------------------------------------
-- 2. The founding organization and its members
-- ---------------------------------------------------------------------------

-- Created on an empty database too, so that a fresh install behaves like the
-- migrated one: new accounts land in the only organization (section 5).
insert into public.organizations (name)
select 'Founding organization'
where not exists (select 1 from public.organizations);

-- Every existing account joins it with the role and badge its profile holds.
-- A banned account is deactivated; a ban that has run out is not a ban.
-- Only while there is exactly one organization: otherwise there is no telling
-- where an account belongs.
insert into public.memberships (org_id, user_id, role, status, badge_number)
select o.id, p.id, p.role,
       case when u.banned_until > now() then 'deactivated' else 'active' end,
       p.badge_number
from public.profiles p
join auth.users u on u.id = p.id
cross join public.organizations o
where (select count(*) from public.organizations) = 1
  and not exists (select 1 from public.memberships m where m.user_id = p.id);

-- ---------------------------------------------------------------------------
-- 3. org_id on the four record tables
-- ---------------------------------------------------------------------------
--
-- The column is added WITH the founding organization as a constant default
-- and the default is dropped straight after. Postgres fills existing rows
-- from such a default without running an UPDATE, so no trigger fires and
-- modified_at stays where it was. SET NOT NULL then fails the migration
-- rather than leave a row without an organization.

do $$
declare
  t text;
  orgs bigint;
  founding uuid;
begin
  foreach t in array array['boreholes', 'pipe_records', 'drilling_events', 'shift_logs']
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'org_id'
    ) then
      select count(*) into orgs from public.organizations;
      if orgs <> 1 then
        raise exception 'Cannot assign existing rows of % to an organization: % organizations exist, expected exactly one.', t, orgs;
      end if;
      select id into founding from public.organizations;

      execute format(
        'alter table public.%I add column org_id uuid default %L references public.organizations (id)',
        t, founding);
      execute format('alter table public.%I alter column org_id drop default', t);
    end if;

    execute format('alter table public.%I alter column org_id set not null', t);
    execute format('create index if not exists %I on public.%I (org_id)', t || '_org_id_idx', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 4. The organization of a row is decided here, not by the client
-- ---------------------------------------------------------------------------
--
-- These run for every role, the service role included. They are security
-- definer because they must see memberships and boreholes the caller's own
-- policies would hide (a crew member adds a pipe to a colleague's borehole).

-- Boreholes. Sent without org_id (every installed build): the author's one
-- active membership decides; with none or several there is nothing to decide
-- by and the write is refused. Sent WITH org_id: left as sent, and the insert
-- policy refuses it unless the caller may write in that organization, so a
-- forged value is rejected, never silently replaced.
create or replace function public.boreholes_org_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  author uuid;
  n bigint;
  only_org uuid;
begin
  if tg_op = 'UPDATE' then
    if new.org_id is distinct from old.org_id then
      raise exception 'A borehole cannot be moved to another organization.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.org_id is null then
    -- The caller when there is one, so that naming someone else as created_by
    -- cannot be used to probe that person's memberships. The service role has
    -- no user, and for it the named author decides.
    author := coalesce(auth.uid(), new.created_by);
    select count(*), (array_agg(m.org_id))[1] into n, only_org
    from public.memberships m
    where m.user_id = author and m.status = 'active';

    if n <> 1 then
      raise exception 'This account is an active member of % organizations; a borehole sent without an organization needs exactly one.', n
        using errcode = '42501';
    end if;
    new.org_id := only_org;
  end if;
  return new;
end;
$$;

-- Pipe records, events and shift logs always belong to their borehole's
-- organization, whatever the client sent. The insert policy then judges the
-- caller against that organization, so a row cannot be attached to another
-- organization's borehole.
create or replace function public.borehole_child_org_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_org uuid;
begin
  if tg_op = 'UPDATE' then
    if new.org_id is distinct from old.org_id then
      raise exception 'A record cannot be moved to another organization.'
        using errcode = '42501';
    end if;
    if new.borehole_id is not distinct from old.borehole_id then
      return new;
    end if;
  end if;

  select b.org_id into parent_org from public.boreholes b where b.id = new.borehole_id;

  if not found then
    -- Without this the row would fail on org_id being null (23502), which the
    -- field app treats as permanent and drops from its outbox. A missing
    -- borehole has always been a foreign-key error (23503), which it retries;
    -- keep it that way.
    raise exception 'insert or update on table "%" violates foreign key constraint: borehole % does not exist', tg_table_name, new.borehole_id
      using errcode = '23503';
  end if;

  if tg_op = 'UPDATE' and parent_org is distinct from old.org_id then
    raise exception 'A record cannot be moved to a borehole of another organization.'
      using errcode = '42501';
  end if;

  new.org_id := parent_org;
  return new;
end;
$$;

drop trigger if exists boreholes_org_guard on public.boreholes;
create trigger boreholes_org_guard
  before insert or update on public.boreholes
  for each row execute function public.boreholes_org_guard();

do $$
declare
  t text;
begin
  foreach t in array array['pipe_records', 'drilling_events', 'shift_logs']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_org_guard', t);
    execute format(
      'create trigger %I before insert or update on public.%I '
      'for each row execute function public.borehole_child_org_guard()',
      t || '_org_guard', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Profiles and bans are mirrored into the membership
-- ---------------------------------------------------------------------------
--
-- Until the apps manage memberships themselves, profiles.role, badge_number
-- and the account ban remain where roles and deactivation are edited. The
-- policies no longer read them, so each change is copied to the membership.
--
-- Mirroring is defined for accounts with at most one membership. With several
-- there is no telling which one a profile edit means, and copying a role into
-- all of them would let one organization's administrator promote someone in
-- another; those accounts are left alone.

create or replace function public.mirror_profile_to_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    -- A new account joins the organization only while there is exactly one.
    insert into public.memberships (org_id, user_id, role, badge_number)
    select o.id, new.id, new.role, new.badge_number
    from public.organizations o
    where (select count(*) from public.organizations) = 1
    on conflict (org_id, user_id) do nothing;
  elsif new.role is distinct from old.role
     or new.badge_number is distinct from old.badge_number then
    -- Status is not touched: a role change must not reactivate anyone.
    update public.memberships m
    set role = new.role, badge_number = new.badge_number
    where m.user_id = new.id
      and (select count(*) from public.memberships x where x.user_id = new.id) = 1;
  end if;
  return null;
end;
$$;

drop trigger if exists profiles_mirror_membership on public.profiles;
create trigger profiles_mirror_membership
  after insert or update on public.profiles
  for each row execute function public.mirror_profile_to_membership();

-- A ban deactivates; lifting it reactivates. Without this a token issued
-- before the ban would keep reading until it expires. A ban whose date has
-- passed counts as lifted. 'invited' is never touched in either direction.
--
-- A ban is deactivated in every organization (denying is the safe direction);
-- lifting one reactivates only the single-membership case described above.
create or replace function public.mirror_ban_to_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.banned_until is not null and new.banned_until > now() then
    update public.memberships m
    set status = 'deactivated'
    where m.user_id = new.id and m.status = 'active';
  else
    update public.memberships m
    set status = 'active'
    where m.user_id = new.id and m.status = 'deactivated'
      and (select count(*) from public.memberships x where x.user_id = new.id) = 1;
  end if;
  return null;
end;
$$;

-- No column list: the WHEN clause is what matters, and it holds however the
-- auth server phrases its UPDATE. Sign-ins update auth.users too; for those
-- the clause is false and the function is never called.
drop trigger if exists on_auth_user_ban_changed on auth.users;
create trigger on_auth_user_ban_changed
  after update on auth.users
  for each row
  when (old.banned_until is distinct from new.banned_until)
  execute function public.mirror_ban_to_membership();

-- ---------------------------------------------------------------------------
-- 6. Helpers for the policies below
-- ---------------------------------------------------------------------------

-- True when the caller holds one of `roles`, actively, in an organization the
-- target user also belongs to. The target's own status does not matter: the
-- name on an old record must still resolve after its author is deactivated.
-- Security definer because a Supervisor cannot read colleagues' memberships.
create or replace function public.shares_org_as(target uuid, variadic roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships mine
    join public.memberships theirs on theirs.org_id = mine.org_id
    where mine.user_id = auth.uid() and mine.status = 'active'
      and mine.role = any (roles)
      and theirs.user_id = target
  );
$$;

-- A path segment as a uuid, or null when it is not one. A bare cast inside a
-- storage policy would raise on any odd path and turn "denied" into an error
-- for everyone listing the bucket. CASE guarantees the cast is only reached
-- for text that has the shape of a uuid.
create or replace function public.uuid_or_null(value text)
returns uuid
language sql
immutable
set search_path = public
as $$
  select case
    when value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then value::uuid
  end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Policies: records and profiles
-- ---------------------------------------------------------------------------
--
-- Same rules as before, each now asked of the row's organization:
--   read    the author while an active member, or a Supervisor/Administrator
--   insert  as oneself, with a crew role (Administrators author nothing)
--   update  the author with a crew role; for pipe records also a reviewer,
--           within the existing column guard
--   delete  no policy, no grant
-- has_org_role() is true only for an ACTIVE member, so a deactivated or
-- invited member passes none of these.
--
-- `to authenticated`: a signed-out client has no policy at all.
-- (select auth.uid()) is evaluated once per statement, not once per row.

do $$
declare
  t text;
begin
  foreach t in array array['boreholes', 'pipe_records', 'drilling_events', 'shift_logs']
  loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format(
      'create policy %I_select on public.%I for select to authenticated using ('
      '(created_by = (select auth.uid()) and public.is_org_member(org_id)) '
      'or public.has_org_role(org_id, ''Supervisor'', ''Administrator''))',
      t, t);

    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format(
      'create policy %I_insert on public.%I for insert to authenticated with check ('
      'created_by = (select auth.uid()) '
      'and public.has_org_role(org_id, ''Driller'', ''Data Logger'', ''Supervisor''))',
      t, t);

    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format(
      'create policy %I_update on public.%I for update to authenticated '
      'using (created_by = (select auth.uid()) '
      'and public.has_org_role(org_id, ''Driller'', ''Data Logger'', ''Supervisor'')) '
      'with check (created_by = (select auth.uid()) '
      'and public.has_org_role(org_id, ''Driller'', ''Data Logger'', ''Supervisor''))',
      t, t);
  end loop;
end
$$;

-- Pipe records: a reviewer of the row's organization may correct it too;
-- pipe_records_guard_update still decides which columns.
drop policy if exists pipe_records_update on public.pipe_records;
create policy pipe_records_update on public.pipe_records
  for update to authenticated
  using (
    (created_by = (select auth.uid())
       and public.has_org_role(org_id, 'Driller', 'Data Logger', 'Supervisor'))
    or public.has_org_role(org_id, 'Supervisor', 'Administrator')
  )
  with check (
    (created_by = (select auth.uid())
       and public.has_org_role(org_id, 'Driller', 'Data Logger', 'Supervisor'))
    or public.has_org_role(org_id, 'Supervisor', 'Administrator')
  );

-- Profiles: one's own, or that of someone in an organization where the caller
-- is Supervisor or Administrator. profiles_update_own and the column grants
-- (role is not self-editable) are untouched.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or public.shares_org_as(id, 'Supervisor', 'Administrator')
  );

-- ---------------------------------------------------------------------------
-- 8. Policies: photos
-- ---------------------------------------------------------------------------
--
-- Two path forms in the drilling-photos bucket:
--   <org_id>/<user_id>/<file>   new
--   <user_id>/<file>            legacy, the only one installed builds know
-- Anything else matches no branch and is denied without an error.
--
-- No UPDATE or DELETE policy exists, as before.

-- Upload: into one's own folder. Under an organization it also needs an
-- active membership there (any role).
drop policy if exists drilling_photos_insert on storage.objects;
create policy drilling_photos_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'drilling-photos'
    and (
      (array_length(storage.foldername(name), 1) = 1
         and (storage.foldername(name))[1] = (select auth.uid())::text)
      or
      (array_length(storage.foldername(name), 1) = 2
         and (storage.foldername(name))[2] = (select auth.uid())::text
         and public.is_org_member(public.uuid_or_null((storage.foldername(name))[1])))
    )
  );

-- Read: Administrators only besides the author, as today.
drop policy if exists drilling_photos_select on storage.objects;
create policy drilling_photos_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'drilling-photos'
    and (
      -- An Administrator reads everything under their organization's folder.
      public.is_org_admin(public.uuid_or_null((storage.foldername(name))[1]))
      -- New path: the author, while an active member of that organization.
      or (array_length(storage.foldername(name), 1) = 2
            and (storage.foldername(name))[2] = (select auth.uid())::text
            and public.is_org_member(public.uuid_or_null((storage.foldername(name))[1])))
      or (array_length(storage.foldername(name), 1) = 1
            and (
              -- Legacy path: the owner. The path names no organization, so
              -- "a deactivated member reads nothing" is applied as: not when
              -- the caller has memberships and none of them is active. An
              -- account with no membership at all still reads its own.
              ((storage.foldername(name))[1] = (select auth.uid())::text
                 and (select count(*) = 0 or bool_or(o.status = 'active')
                      from public.my_organizations() o))
              -- ... or an Administrator of an organization the owner is in.
              or public.shares_org_as(
                   public.uuid_or_null((storage.foldername(name))[1]), 'Administrator')
            ))
    )
  );

-- ---------------------------------------------------------------------------
-- 9. TRUNCATE
-- ---------------------------------------------------------------------------

-- Supabase's default privileges include TRUNCATE, which row level security
-- does not govern. The API cannot send one today, but no client role should
-- hold it on any table.
do $$
declare
  r record;
begin
  for r in select tablename from pg_tables where schemaname = 'public'
  loop
    execute format('revoke truncate on public.%I from anon, authenticated', r.tablename);
  end loop;
end
$$;
