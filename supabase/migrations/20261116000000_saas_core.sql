-- SaaS foundation: organizations, memberships, platform administrators and an
-- audit log, with the helper functions policies are written against.
--
-- This file is meant to be lifted into another application unchanged, so it
-- names nothing that belongs to one: no application table, no role vocabulary,
-- no bucket. An application's own migration adds its role names (by replacing
-- saas_admin_roles() and constraining memberships.role) and scopes its tables
-- with the helpers below.
--
-- Clients only ever read these tables, and only through the policies here.
-- Every write goes through the service role or a migration, which is why no
-- INSERT, UPDATE or DELETE is granted to the API roles at all.
--
-- Re-runnable: applying it a second time changes nothing and keeps the rows.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

-- One DO block, which is one statement. A hosted Supabase project hands every
-- new table in public to the API roles, in full, the moment it is created (a
-- database built from migrations alone, the local image and CI, hands them
-- nothing). If creating, enabling row level security and revoking were
-- separate statements and this file were applied one statement at a time, a
-- signed-out client could write to these tables in between, and the rows
-- would stay. Inside one statement there is no in-between.
do $$
begin
  create table if not exists public.organizations (
    id         uuid primary key default gen_random_uuid(),
    name       text not null,
    created_at timestamptz not null default now()
  );

  create table if not exists public.memberships (
    -- No cascade: an organization that still has members is not deleted by
    -- accident.
    org_id       uuid not null references public.organizations (id),
    -- Cascade: deleting an account removes its memberships, so an account
    -- stays deletable.
    user_id      uuid not null references auth.users (id) on delete cascade,
    -- Free text here; the application constrains it to its own vocabulary.
    role         text not null,
    status       text not null default 'active'
                   check (status in ('invited', 'active', 'deactivated')),
    badge_number text,
    created_at   timestamptz not null default now(),
    primary key (org_id, user_id)
  );

  create table if not exists public.platform_admins (
    user_id uuid primary key references auth.users (id) on delete cascade
  );

  create table if not exists public.audit_log (
    id       bigint generated always as identity primary key,
    at       timestamptz not null default now(),
    -- Deliberately not foreign keys: the log must outlive the account and the
    -- organization it describes.
    actor_id uuid,
    org_id   uuid,
    action   text not null,
    target   text,
    details  jsonb
  );

  alter table public.organizations   enable row level security;
  alter table public.memberships     enable row level security;
  alter table public.platform_admins enable row level security;
  alter table public.audit_log       enable row level security;

  -- Privileges are stated in full rather than inherited. Revoking everything
  -- and granting exactly what is needed ends in the same place from either
  -- start: signed-in users may SELECT (RLS decides which rows), the service
  -- role does the writing, a signed-out client has nothing.
  revoke all on public.organizations, public.memberships, public.platform_admins, public.audit_log
    from anon, authenticated;
  revoke all on sequence public.audit_log_id_seq from anon, authenticated;
  grant select on public.organizations, public.memberships, public.platform_admins, public.audit_log
    to authenticated;
  grant all on public.organizations, public.memberships, public.platform_admins, public.audit_log
    to service_role;
  grant usage, select on sequence public.audit_log_id_seq to service_role;
end
$$;

-- The primary key leads with org_id; "which organizations is this user in"
-- needs the other direction.
create index if not exists memberships_user_id_idx
  on public.memberships (user_id);

-- ---------------------------------------------------------------------------
-- Helper functions
-- ---------------------------------------------------------------------------
--
-- All are security definer so that a policy can ask about memberships without
-- going back through the policies on memberships (which would recurse), and
-- all pin search_path. Each answers only about the caller. EXECUTE is granted
-- to signed-in users and the service role and taken from everyone else (see
-- the end of this section).

-- Only an ACTIVE membership counts: invited and deactivated members get
-- nothing through these.
create or replace function public.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = org and m.user_id = auth.uid() and m.status = 'active'
  );
$$;

create or replace function public.has_org_role(org uuid, variadic roles text[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = org and m.user_id = auth.uid() and m.status = 'active'
      and m.role = any (roles)
  );
$$;

-- The role names that administer an organization. Created only when absent:
-- an application replaces it with its own vocabulary, and applying this file
-- again must not put the default back underneath it.
do $$
begin
  if to_regprocedure('public.saas_admin_roles()') is null then
    execute $f$
      create function public.saas_admin_roles()
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

create or replace function public.is_org_admin(org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.has_org_role(org, variadic public.saas_admin_roles());
$$;

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.platform_admins p where p.user_id = auth.uid()
  );
$$;

-- One row per membership of the caller, whatever its status, so an app can
-- tell a deactivated member why they see nothing. This is the one place a
-- non-active member learns anything.
create or replace function public.my_organizations()
returns table (org_id uuid, name text, role text, status text)
language sql
stable
security definer
set search_path = public
as $$
  select m.org_id, o.name, m.role, m.status
  from public.memberships m
  join public.organizations o on o.id = m.org_id
  where m.user_id = auth.uid();
$$;

-- PostgreSQL lets PUBLIC execute every new function, and a hosted project
-- grants it to the signed-out role by name as well. A signed-out client has no
-- business calling functions that run with the owner's rights, so both go.
-- Granted first, revoked second: at no point between the two statements is a
-- signed-in user without the helpers the policies call.
grant execute on function
  public.is_org_member(uuid), public.has_org_role(uuid, text[]), public.saas_admin_roles(),
  public.is_org_admin(uuid), public.is_platform_admin(), public.my_organizations()
  to authenticated, service_role;
revoke execute on function
  public.is_org_member(uuid), public.has_org_role(uuid, text[]), public.saas_admin_roles(),
  public.is_org_admin(uuid), public.is_platform_admin(), public.my_organizations()
  from public, anon;

-- ---------------------------------------------------------------------------
-- Read policies
-- ---------------------------------------------------------------------------
--
-- `to authenticated`: a signed-out client has no policy at all. Calls that do
-- not depend on the row are wrapped in (select ...) so the planner evaluates
-- them once per statement rather than once per row.

drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations
  for select to authenticated
  using (public.is_org_member(id) or (select public.is_platform_admin()));

-- A member reads their own membership while it is active; an organization
-- admin reads the whole organization's.
drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships
  for select to authenticated
  using (
    (user_id = (select auth.uid()) and public.is_org_member(org_id))
    or public.is_org_admin(org_id)
    or (select public.is_platform_admin())
  );

drop policy if exists platform_admins_select on public.platform_admins;
create policy platform_admins_select on public.platform_admins
  for select to authenticated
  using ((select public.is_platform_admin()));

-- Rows with no organization are platform events: platform administrators only.
drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log
  for select to authenticated
  using ((select public.is_platform_admin()) or public.is_org_admin(org_id));
