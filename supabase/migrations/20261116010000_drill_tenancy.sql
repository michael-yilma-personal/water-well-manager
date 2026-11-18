-- Tenancy for Drill: every record belongs to an organization, and every
-- policy asks about the caller's membership of THAT organization instead of
-- the single global profiles.role.
--
-- Installed builds (1.1.7), the current dashboard and the admin-users Edge
-- Function know nothing about organizations and are not changed here:
--   - they send no org_id: triggers fill it in (section 6);
--   - they read and write profiles.role and badge_number, and ban accounts:
--     triggers mirror that into the membership in the FOUNDING organization,
--     and only there (section 3);
--   - they store photos under <user_id>/<file>: still accepted (section 9).
--
-- Existing data moves into one founding organization. Nothing about an
-- existing row changes except that it gains org_id; in particular
-- modified_at does not move, or every device would download everything again.
--
-- Written so that it is safe even if the tool applying it does NOT wrap the
-- file in one transaction: after every single statement an installed build
-- can still insert. Where two changes must not be seen apart (dropping and
-- re-creating a policy, revoking and granting) they share one DO block,
-- which is one statement.
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
-- 2. The founding organization
-- ---------------------------------------------------------------------------
--
-- The founding organization is the one the pre-tenancy data, accounts and
-- photos belong to. It is identified by a flag on its row, never by its name
-- (the owner will rename it) or its age. The flag travels with the data, so a
-- copy of the database restored elsewhere still knows which one it is. The
-- partial unique index allows at most one.

alter table public.organizations
  add column if not exists is_founding boolean not null default false;
create unique index if not exists organizations_one_founding_idx
  on public.organizations (is_founding) where is_founding;

-- True on a membership that a BAN deactivated, so that lifting the ban brings
-- back that membership and not one an administrator deactivated on purpose.
alter table public.memberships
  add column if not exists deactivated_by_ban boolean not null default false;

-- The mark means "the deactivation in force is a ban's", so it cannot outlive
-- that deactivation: a membership that is not deactivated never carries it.
-- So a membership reactivated and then deactivated on purpose while the
-- account was banned stays deactivated when the ban is lifted: reactivating
-- cleared the mark, and only the ban mirror of section 3 sets it again (in
-- the same statement that deactivates).
create or replace function public.membership_ban_mark_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status <> 'deactivated' then
    new.deactivated_by_ban := false;
  end if;
  return new;
end;
$$;

do $$
begin
  drop trigger if exists memberships_ban_mark_guard on public.memberships;
  create trigger memberships_ban_mark_guard
    before insert or update on public.memberships
    for each row execute function public.membership_ban_mark_guard();
end
$$;

-- Null when there is none (never the case once section 4 has run). Used only
-- inside other security definer functions, so no client role may call it.
create or replace function public.founding_org_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select o.id from public.organizations o where o.is_founding;
$$;
revoke execute on function public.founding_org_id() from public, anon, authenticated;
grant execute on function public.founding_org_id() to service_role;

-- ---------------------------------------------------------------------------
-- 3. Profiles and bans are mirrored into the founding membership
-- ---------------------------------------------------------------------------
--
-- Until the apps manage memberships themselves, profiles.role, badge_number
-- and the account ban remain where roles and deactivation are edited. The
-- policies no longer read them, so each change is copied to the membership.
--
-- Only ever to the membership in the FOUNDING organization. The legacy
-- tables are global and so is whoever edits them (admin-users acts for the
-- founding organization's Administrator); copying into any other
-- organization would let that person re-role, deactivate or reactivate
-- another company's members. An account with no founding membership is left
-- alone.
--
-- Created BEFORE the members are enrolled (section 4), so that an account
-- created, re-roled or banned at any point of this migration is not missed:
-- until an organization is flagged these do nothing, and the enrolment reads
-- profiles and bans as they are at that moment; from then on these carry
-- every change.

create or replace function public.mirror_profile_to_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  founding uuid := public.founding_org_id();
begin
  if founding is null then
    return null;
  end if;

  if tg_op = 'INSERT' then
    -- What account creation has always meant: a new member of the (founding)
    -- organization, whether or not other organizations exist by now.
    insert into public.memberships (org_id, user_id, role, badge_number)
    values (founding, new.id, new.role, new.badge_number)
    on conflict (org_id, user_id) do nothing;
    return null;
  end if;

  -- Only the column that changed is copied. Anyone may edit their own badge;
  -- if that also copied profiles.role, an account whose legacy role is
  -- higher than its membership role would promote itself by doing so.
  -- Status is never touched: a role change must not reactivate anyone.
  if new.role is distinct from old.role then
    update public.memberships m
    set role = new.role
    where m.org_id = founding and m.user_id = new.id;
  end if;
  if new.badge_number is distinct from old.badge_number then
    update public.memberships m
    set badge_number = new.badge_number
    where m.org_id = founding and m.user_id = new.id;
  end if;
  return null;
end;
$$;

do $$
begin
  drop trigger if exists profiles_mirror_membership on public.profiles;
  create trigger profiles_mirror_membership
    after insert or update on public.profiles
    for each row execute function public.mirror_profile_to_membership();
end
$$;

-- A ban deactivates the founding membership; lifting it reactivates that
-- membership, and only if the ban is what deactivated it. Without this a
-- token issued before the ban would keep reading until it expires. A ban
-- whose date has passed counts as lifted. 'invited' is never touched.
--
-- Both branches write public.memberships whether or not a founding
-- organization exists yet, and must keep doing so (no early return): the
-- write holds a lock on that table until the ban's transaction ends, and
-- that lock is what the enrolment of section 4 waits for.
create or replace function public.mirror_ban_to_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  founding uuid := public.founding_org_id();
begin
  if new.banned_until is not null and new.banned_until > now() then
    update public.memberships m
    set status = 'deactivated', deactivated_by_ban = true
    where m.org_id = founding and m.user_id = new.id and m.status = 'active';
  else
    update public.memberships m
    set status = 'active', deactivated_by_ban = false
    where m.org_id = founding and m.user_id = new.id
      and m.status = 'deactivated' and m.deactivated_by_ban;
  end if;
  return null;
end;
$$;

-- No column list: the WHEN clause is what matters, and it holds however the
-- auth server phrases its UPDATE. Sign-ins update auth.users too; for those
-- the clause is false and the function is never called.
do $$
begin
  drop trigger if exists on_auth_user_ban_changed on auth.users;
  create trigger on_auth_user_ban_changed
    after update on auth.users
    for each row
    when (old.banned_until is distinct from new.banned_until)
    execute function public.mirror_ban_to_membership();
end
$$;

-- ---------------------------------------------------------------------------
-- 4. The founding organization is flagged and its members enrolled
-- ---------------------------------------------------------------------------
--
-- One DO block, so one statement: the flag and the memberships appear
-- together, and the triggers of section 3 take over from exactly there.
--
-- It does its work on a FIRST application, which is any of:
--   - no organization is flagged yet (never applied, or applied again after
--     this migration's rollback, which drops the flag): the founding
--     organization is flagged, and created when the database has none, so
--     that a fresh install behaves like the migrated one;
--   - the record tables carry no org_id yet: this migration is not in force,
--     however the flag came to be set;
--   - the founding organization has no membership at all, however its flag
--     came to be set (for instance by hand, as the error below asks).
-- Then:
--   - Every membership the founding organization already has is brought into
--     line with the legacy tables, which were the only place roles, badges
--     and bans were edited while this migration was not in force (after its
--     rollback the memberships stay and the mirror is gone). Role and badge
--     come from the profile. Status comes from the ban alone, because under
--     the legacy model a ban is the only deactivation: banned is deactivated
--     and marked as the ban's doing, not banned is active. 'invited' is left
--     as it is. A ban that has run out is not a ban.
--   - Every account that has no membership in ANY organization is enrolled
--     with the role and badge its profile holds; a banned one is deactivated.
--     An account that belongs to another organization is never added to the
--     founding one here, whatever its status there.
--
-- A plain re-application (flagged, in force, has members) skips all of it:
-- memberships are managed on their own by then, a direct deactivation must
-- stay, and a member who was removed is not enrolled a second time.
do $$
declare
  orgs bigint;
  founding uuid := public.founding_org_id();
  first_application boolean;
begin
  first_application := founding is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'boreholes' and column_name = 'org_id')
    or not exists (select 1 from public.memberships m where m.org_id = founding);
  if not first_application then
    return;
  end if;

  -- Waits for profile writes already under way (an account being created or
  -- re-roled whose trigger saw no founding organization yet) and holds new
  -- ones until this statement is through, so none falls between the two.
  --
  -- The same for bans and unbans, through public.memberships: the ban mirror
  -- writes that table in every case, so a ban whose transaction is still open
  -- holds a lock on it, and this waits until that transaction has ended; the
  -- statements below then read the ban it committed. A ban that starts later
  -- waits in its trigger until the memberships are there. auth.users itself
  -- is not locked: that needs a privilege the role applying this may not
  -- hold on a hosted project. (A ban that began before the trigger existed
  -- was waited for by CREATE TRIGGER in section 3.)
  lock table public.profiles, public.memberships in share row exclusive mode;

  if founding is null then
    select count(*) into orgs from public.organizations;
    if orgs = 0 then
      insert into public.organizations (name, is_founding)
      values ('Founding organization', true)
      returning id into founding;
    elsif orgs = 1 then
      update public.organizations set is_founding = true returning id into founding;
    else
      -- A failed application takes the flag column away again when the file
      -- is applied as one transaction, so the instructions add it too.
      raise exception 'Cannot tell which of % organizations is the founding one (the one the existing accounts, records and photos belong to). Mark it by hand, then apply this migration again: ALTER TABLE public.organizations ADD COLUMN IF NOT EXISTS is_founding boolean NOT NULL DEFAULT false; UPDATE public.organizations SET is_founding = true WHERE id = ''<id of the founding organization>'';', orgs;
    end if;
  end if;

  update public.memberships m
  set role = p.role,
      badge_number = p.badge_number,
      status = case
                 when m.status = 'invited' then m.status
                 when u.banned_until > now() then 'deactivated'
                 else 'active'
               end,
      deactivated_by_ban = m.status <> 'invited' and coalesce(u.banned_until > now(), false)
  from public.profiles p
  join auth.users u on u.id = p.id
  where m.org_id = founding and m.user_id = p.id;

  insert into public.memberships (org_id, user_id, role, status, deactivated_by_ban, badge_number)
  select founding, p.id, p.role,
         case when u.banned_until > now() then 'deactivated' else 'active' end,
         coalesce(u.banned_until > now(), false),
         p.badge_number
  from public.profiles p
  join auth.users u on u.id = p.id
  where not exists (select 1 from public.memberships x where x.user_id = p.id)
  on conflict (org_id, user_id) do nothing;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. org_id on the four record tables
-- ---------------------------------------------------------------------------
--
-- The column is added WITH the founding organization as a constant default.
-- Postgres fills existing rows from such a default without running an UPDATE,
-- so no trigger fires and modified_at stays where it was. SET NOT NULL then
-- fails the migration rather than leave a row without an organization.
--
-- The default stays until the triggers of section 6 exist and is dropped
-- only then (end of section 6). Dropped any earlier, an installed build's
-- insert would fail on a null org_id (23502), which the app treats as
-- permanent and drops from its outbox.

do $$
declare
  t text;
  founding uuid := public.founding_org_id();
begin
  foreach t in array array['boreholes', 'pipe_records', 'drilling_events', 'shift_logs']
  loop
    if not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'org_id'
    ) then
      if founding is null then
        raise exception 'Cannot assign existing rows of % to an organization: no founding organization is flagged.', t;
      end if;
      execute format(
        'alter table public.%I add column org_id uuid default %L references public.organizations (id)',
        t, founding);
    end if;

    execute format('alter table public.%I alter column org_id set not null', t);
    execute format('create index if not exists %I on public.%I (org_id)', t || '_org_id_idx', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 6. The organization of a row is decided here, not by the client
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

-- Dropping and creating a trigger in one statement: there is no moment
-- without it when this file is applied a second time.
do $$
declare
  t text;
begin
  drop trigger if exists boreholes_org_guard on public.boreholes;
  create trigger boreholes_org_guard
    before insert or update on public.boreholes
    for each row execute function public.boreholes_org_guard();

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

-- The triggers now fill org_id, so the temporary default of section 5 goes:
-- from here a borehole sent without an organization is decided by the
-- author's membership, not by a constant.
alter table public.boreholes       alter column org_id drop default;
alter table public.pipe_records    alter column org_id drop default;
alter table public.drilling_events alter column org_id drop default;
alter table public.shift_logs      alter column org_id drop default;

-- ---------------------------------------------------------------------------
-- 7. Helpers for the policies below
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

-- Photos under the legacy path <user_id>/<file> name no organization. They
-- belong to the founding organization: its Administrator reads them, and no
-- other organization's does, whatever else the owner later joins. The owner
-- must be (or have been) a founding member, so that a legacy-path upload by
-- someone who only belongs to another company is not exposed to the founding
-- Administrator.
create or replace function public.reads_legacy_photos_of(owner uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_admin(f.id)
     and exists (
       select 1 from public.memberships m
       where m.org_id = f.id and m.user_id = owner)
  from (select public.founding_org_id() as id) f;
$$;

-- The owner's side of the same rule: the legacy path is the founding
-- organization's, so uploading there and reading one's own there need an
-- ACTIVE membership in it. A membership anywhere else gives nothing here, and
-- neither does having none.
create or replace function public.is_founding_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_member(public.founding_org_id());
$$;

-- As in saas_core: signed-in users and the service role, nobody else.
grant execute on function public.shares_org_as(uuid, text[]), public.reads_legacy_photos_of(uuid),
  public.is_founding_member()
  to authenticated, service_role;
revoke execute on function public.shares_org_as(uuid, text[]), public.reads_legacy_photos_of(uuid),
  public.is_founding_member()
  from public, anon;

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
-- 8. Policies: records and profiles
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
--
-- Each old policy is dropped and its replacement created inside one DO
-- block: with no policy at all in between, every write would be refused.

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
    if t = 'pipe_records' then
      -- A reviewer of the row's organization may correct a pipe record too;
      -- pipe_records_guard_update still decides which columns.
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
    else
      execute format(
        'create policy %I_update on public.%I for update to authenticated '
        'using (created_by = (select auth.uid()) '
        'and public.has_org_role(org_id, ''Driller'', ''Data Logger'', ''Supervisor'')) '
        'with check (created_by = (select auth.uid()) '
        'and public.has_org_role(org_id, ''Driller'', ''Data Logger'', ''Supervisor''))',
        t, t);
    end if;
  end loop;
end
$$;

-- Profiles: one's own, or that of someone in an organization where the caller
-- is Supervisor or Administrator. profiles_update_own and the column grants
-- (role is not self-editable) are untouched.
do $$
begin
  drop policy if exists profiles_select on public.profiles;
  create policy profiles_select on public.profiles
    for select to authenticated
    using (
      id = (select auth.uid())
      or public.shares_org_as(id, 'Supervisor', 'Administrator')
    );
end
$$;

-- ---------------------------------------------------------------------------
-- 9. Policies: photos
-- ---------------------------------------------------------------------------
--
-- Two path forms in the drilling-photos bucket:
--   <org_id>/<user_id>/<file>   new
--   <user_id>/<file>            legacy, the only one installed builds know
-- Anything else matches no branch and is denied without an error.
--
-- No UPDATE or DELETE policy exists, as before.

do $$
begin
  -- Upload: into one's own folder, by an active member. Under an
  -- organization, of that organization; on the legacy path, of the founding
  -- organization, which is the one that path belongs to.
  drop policy if exists drilling_photos_insert on storage.objects;
  create policy drilling_photos_insert on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'drilling-photos'
      and (
        (array_length(storage.foldername(name), 1) = 1
           and (storage.foldername(name))[1] = (select auth.uid())::text
           and (select public.is_founding_member()))
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
                -- Legacy path: the owner, while an active member of the
                -- founding organization.
                ((storage.foldername(name))[1] = (select auth.uid())::text
                   and (select public.is_founding_member()))
                -- ... or the founding organization's Administrator.
                or public.reads_legacy_photos_of(
                     public.uuid_or_null((storage.foldername(name))[1]))
              ))
      )
    );
end
$$;

-- ---------------------------------------------------------------------------
-- 10. Privileges, stated in full
-- ---------------------------------------------------------------------------
--
-- The earlier migrations only subtracted from whatever the API roles held by
-- default. On a hosted project that default is everything (TRUNCATE,
-- REFERENCES, TRIGGER and, from PostgreSQL 17, MAINTAIN included, for the
-- signed-out role too); on a database built from the migrations alone it is
-- nothing, and the app could not read its own tables. Revoke everything, then
-- grant exactly what each role uses, so both end the same:
--   anon           nothing
--   authenticated  records: SELECT, INSERT, UPDATE (no DELETE: deletion is soft)
--                  profiles: SELECT, and UPDATE of name and badge_number only,
--                  so role stays not self-editable
--   service_role   everything (the admin-users function)
-- Row level security still decides which rows. A table-level REVOKE also
-- clears column-level grants, so the profiles column grant is made after it.
-- The foundation's tables are granted in saas_core.
--
-- One DO block, so the revoke and the grants are a single statement: there is
-- no moment at which a signed-in user holds nothing.

do $$
begin
  revoke all on public.profiles, public.boreholes, public.pipe_records,
    public.drilling_events, public.shift_logs
    from anon, authenticated;

  grant select, insert, update on public.boreholes, public.pipe_records,
    public.drilling_events, public.shift_logs
    to authenticated;

  grant select on public.profiles to authenticated;
  grant update (name, badge_number) on public.profiles to authenticated;

  grant all on public.profiles, public.boreholes, public.pipe_records,
    public.drilling_events, public.shift_logs
    to service_role;
end
$$;

-- The pre-tenancy helpers. No policy calls them any more (the rollback's
-- policies would), but they run with the owner's rights and report on
-- profiles.role, so a signed-out client loses them like the others. Done
-- last: until section 8 the old policies still called them for every role.
grant execute on function public.is_admin(), public.is_reviewer() to authenticated, service_role;
revoke execute on function public.is_admin(), public.is_reviewer() from public, anon;
