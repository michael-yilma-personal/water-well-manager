-- Rollback of 20261116010000_drill_tenancy.sql.
--
-- Puts back the policies exactly as the six pre-tenancy migrations left them
-- (they trust profiles.role through is_admin() / is_reviewer() again), then
-- drops what the migration added. Run the saas_core rollback after this one.
--
-- What is lost: org_id on every record. While everything belongs to the
-- founding organization that loses nothing. The pre-tenancy policies know no
-- organizations: whatever another organization holds (a record row, a photo
-- under its folder, a member) would join the one pool under the old global
-- roles. The first statement below refuses to go on in any of those cases.
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
--
-- Written, like the migration, so that it is safe even if the tool applying
-- it does NOT wrap the file in one transaction: after every single statement
-- nobody can change their own profiles.role, and an installed build inserts,
-- upserts, reads and uploads as it did before that statement or as it will
-- after the last. Where two changes must not be seen apart they share one DO
-- block, which is one statement. The order matters as well:
--   1. the policies go back first, while org_id and its triggers still work
--      (the old policies do not look at org_id);
--   2. then the triggers that fill org_id and the column go together;
--   3. only then the mirror, which until that moment gives a new account the
--      membership those triggers ask for;
--   4. the wider grants come last, in one statement.

-- ---------------------------------------------------------------------------
-- Guard: never merge two companies
-- ---------------------------------------------------------------------------

-- First, and before anything is changed, so that it holds even when this
-- file is not run as one transaction.
--
-- Looks at everything that belongs to an organization: every row of the four
-- record tables, every membership, every photo stored under an
-- organization's folder (drilling-photos/<org_id>/...), and every photo whose
-- path has the shape of the new one (<uuid>/<uuid>/...), which belongs to the
-- organization its first segment names even when that organization's row is
-- gone. Each is asked on its own; that a child row follows its borehole is
-- not relied on.
--   - With a founding organization marked: refuses when any of it belongs to
--     another organization, whether or not that one still has members.
--   - With none marked (the mark was lost, or a rollback is run twice and the
--     flag is gone): there is nothing to tell the founding one by, so it
--     refuses when what is there belongs to more than one organization.
-- What has already gone (org_id after a first run, the foundation's tables)
-- is skipped.
do $$
declare
  t text;
  parts text[] := '{}';
  founding uuid;
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

  if to_regclass('public.memberships') is not null then
    parts := parts || 'select org_id from public.memberships'::text;
  end if;

  -- A folder name is compared without regard to case, as the policies do.
  if to_regclass('public.organizations') is not null and to_regclass('storage.objects') is not null then
    parts := parts || (
      'select o.id as org_id from public.organizations o where exists ('
      'select 1 from storage.objects f where f.bucket_id = ''drilling-photos'' '
      'and f.name like ''%/%'' and lower(split_part(f.name, ''/'', 1)) = o.id::text)')::text;
  end if;

  -- A photo at <uuid>/<uuid>/... is a photo of the organization its first
  -- segment names, whether or not a row with that id exists (any more): after
  -- the rollback any Administrator of the one pool would read it. A legacy
  -- path (<user id>/<file>) has no third segment and is not looked at here.
  -- The cast is inside a CASE so that it is only ever reached for text that
  -- has the shape of a uuid, wherever the planner puts the conditions.
  if to_regclass('storage.objects') is not null then
    parts := parts || (
      'select case when f.name ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.'' '
      'then lower(split_part(f.name, ''/'', 1))::uuid end as org_id '
      'from storage.objects f where f.bucket_id = ''drilling-photos'' '
      'and f.name ~* ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.''')::text;
  end if;

  if array_length(parts, 1) is null then
    return;
  end if;

  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'organizations' and column_name = 'is_founding'
  ) then
    execute 'select o.id from public.organizations o where o.is_founding' into founding;
  end if;

  if founding is not null then
    execute 'select count(distinct x.org_id) from (' || array_to_string(parts, ' union all ') || ') x '
            'where x.org_id is distinct from $1' into holders using founding;
    if holders > 0 then
      raise exception 'Refusing to roll back: % organization(s) other than the founding one still hold records, photos or members. The pre-tenancy policies know no organizations and would show all of it to every reviewer of the one pool. Move or remove what they hold first.', holders;
    end if;
  else
    execute 'select count(distinct x.org_id) from (' || array_to_string(parts, ' union all ') || ') x' into holders;
    if holders > 1 then
      raise exception 'Refusing to roll back: no organization is marked as the founding one and % organizations hold records, photos or members. The pre-tenancy policies know no organizations and would merge them into one pool.', holders;
    end if;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Policies, as they were
-- ---------------------------------------------------------------------------
--
-- Each policy is dropped and its predecessor created inside one DO block:
-- with no policy at all in between, every write (or read) would be refused.
-- The old policies call is_admin() and is_reviewer(), which signed-in users
-- may execute throughout.

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
    if t = 'pipe_records' then
      -- A reviewer may correct a pipe record too.
      create policy pipe_records_update on public.pipe_records
        for update
        using ((created_by = auth.uid() and not public.is_admin()) or public.is_reviewer())
        with check ((created_by = auth.uid() and not public.is_admin()) or public.is_reviewer());
    else
      execute format(
        'create policy %I_update on public.%I for update '
        'using (created_by = auth.uid() and not public.is_admin()) '
        'with check (created_by = auth.uid() and not public.is_admin())',
        t, t);
    end if;
  end loop;
end
$$;

do $$
begin
  drop policy if exists profiles_select on public.profiles;
  create policy profiles_select on public.profiles
    for select using (id = auth.uid() or public.is_reviewer());
end
$$;

do $$
begin
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
end
$$;

-- ---------------------------------------------------------------------------
-- org_id, and the triggers that fill it
-- ---------------------------------------------------------------------------
--
-- One statement for all four tables. org_id is NOT NULL and has no default:
-- without its trigger an installed build's insert fails on the null (23502),
-- which the app treats as permanent and drops from its outbox; and a child
-- table's trigger reads boreholes.org_id, so it cannot outlive that column
-- either. The index and the foreign key go with the column.
do $$
declare
  t text;
begin
  foreach t in array array['boreholes', 'pipe_records', 'drilling_events', 'shift_logs']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_org_guard', t);
  end loop;
  foreach t in array array['boreholes', 'pipe_records', 'drilling_events', 'shift_logs']
  loop
    execute format('alter table public.%I drop column if exists org_id', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- The other triggers, and the functions the migration added
-- ---------------------------------------------------------------------------
--
-- The mirror goes only now: while the org_id triggers were there, a borehole
-- needed its author's membership, and the mirror is what gives a new account
-- one.

drop trigger if exists on_auth_user_ban_changed on auth.users;
drop trigger if exists profiles_mirror_membership on public.profiles;
drop trigger if exists memberships_ban_mark_guard on public.memberships;

drop function if exists public.mirror_ban_to_membership();
drop function if exists public.mirror_profile_to_membership();
drop function if exists public.boreholes_org_guard();
drop function if exists public.borehole_child_org_guard();
drop function if exists public.shares_org_as(uuid, text[]);
drop function if exists public.reads_legacy_photos_of(uuid);
drop function if exists public.is_founding_member();
drop function if exists public.membership_ban_mark_guard();
drop function if exists public.uuid_or_null(text);
drop function if exists public.founding_org_id();

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

-- One DO block, so one statement. Granted piece by piece, there would be a
-- moment at which a signed-in user holds UPDATE on all of public.profiles,
-- role included, which the restored policies trust: an Administrator for
-- good. And the signed-out role would hold the tables before it may execute
-- the functions their policies call.
do $$
begin
  grant all on public.profiles, public.boreholes, public.pipe_records,
    public.drilling_events, public.shift_logs
    to anon, authenticated, service_role;

  revoke delete on public.boreholes, public.pipe_records,
    public.drilling_events, public.shift_logs
    from anon, authenticated;

  -- Table-level UPDATE goes (which also clears the column grant), then the
  -- two editable columns come back: role is not self-editable.
  revoke update, delete on public.profiles from anon, authenticated;
  grant update (name, badge_number) on public.profiles to authenticated;

  -- The migration took is_admin() and is_reviewer() away from signed-out
  -- clients. The restored policies apply to every role and call them, so
  -- they go back to everyone, which is also what a hosted project had.
  grant execute on function public.is_admin(), public.is_reviewer()
    to public, anon, authenticated, service_role;
end
$$;
