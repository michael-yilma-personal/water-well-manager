-- STAND-IN FOR SUPABASE. NOT SUPABASE.
--
-- supabase/tests/local.sh loads this into a throwaway PostgreSQL cluster so the
-- migrations and the database tests can run on a machine with no Docker. It
-- holds the minimum of what the Supabase image provides that the migrations
-- and tests touch: the API roles, the privileges they get on `public` (in
-- either of two worlds, see below), `auth.users` with `auth.uid()` / `auth.jwt()` / `auth.role()`, and
-- `storage.buckets` / `storage.objects` with `storage.foldername()`.
--
-- It is written from Supabase's published schema, by hand. Where it differs
-- from the real image, the real image is right: CI's `database` job runs the
-- same tests (supabase/tests/run.sh) against Supabase's own Postgres image and
-- is the authority. Never load this file into a Supabase project.

do $$
begin
  if exists (select 1 from pg_namespace where nspname in ('auth', 'storage')) then
    raise exception 'This database already has an auth or storage schema. The stub is for an empty scratch database only.';
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

-- Roles belong to the cluster, not the database, and local.sh loads this file
-- into several databases of one scratch cluster.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- public: two worlds
-- ---------------------------------------------------------------------------
-- What the API roles get on a table that a migration creates in `public`
-- differs between the two places these migrations run:
--
--   bare    (the default) nothing. This is what Supabase's local image gives,
--           and so what CI's `database` job sees: a migration that does not
--           grant explicitly leaves `authenticated` and `service_role` with
--           "permission denied".
--   hosted  everything: default privileges grant ALL on tables, functions and
--           sequences to anon, authenticated and service_role. This is what
--           production and staging have, and what the pre-tenancy migrations
--           silently relied on.
--
-- Choose with `psql -v world=hosted`. The tenancy migrations must end in the
-- same explicit privileges from either start (Phase 1 criterion 25).

\if :{?world}
\else
  \set world bare
\endif
select :'world' in ('bare', 'hosted') as world_ok, :'world' = 'hosted' as world_hosted \gset
\if :world_ok
\else
  \echo 'supabase_stub.sql: world must be bare or hosted'
  select 1 / 0 as "unknown world";
\endif

grant usage on schema public to anon, authenticated, service_role;

\if :world_hosted
  alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
\endif

-- ---------------------------------------------------------------------------
-- auth
-- ---------------------------------------------------------------------------

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id                 uuid primary key,
  email              text unique,
  raw_user_meta_data jsonb,
  raw_app_meta_data  jsonb,
  banned_until       timestamptz,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
-- As on Supabase: the API roles cannot read auth.users directly.
grant all on auth.users to service_role;

create function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

-- ---------------------------------------------------------------------------
-- storage
-- ---------------------------------------------------------------------------

create schema storage;
grant usage on schema storage to anon, authenticated, service_role;

create table storage.buckets (
  id         text primary key,
  name       text not null unique,
  owner      uuid,
  public     boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table storage.objects (
  id               uuid primary key default gen_random_uuid(),
  bucket_id        text references storage.buckets (id),
  name             text,
  owner            uuid,
  owner_id         text,
  metadata         jsonb,
  created_at       timestamptz default now(),
  updated_at       timestamptz default now(),
  last_accessed_at timestamptz default now(),
  unique (bucket_id, name)
);

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;

grant all on storage.buckets, storage.objects to anon, authenticated, service_role;

-- Same definition as Supabase Storage: every path segment except the file name.
create function storage.foldername(name text) returns text[]
language plpgsql immutable
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts, 1) - 1];
end
$$;

create function storage.filename(name text) returns text
language plpgsql immutable
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end
$$;
