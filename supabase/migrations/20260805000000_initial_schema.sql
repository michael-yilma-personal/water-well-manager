-- Water well drilling manager: initial schema.
--
-- Field devices push their own records up; they never pull another device's
-- data. Administrators read everything and write nothing.
--
-- Every table has RLS enabled, and that is load-bearing rather than defensive:
-- the publishable API key ships inside the APK, so RLS is the only thing
-- standing between that key and the data.

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  name         text not null,
  role         text not null default 'Driller'
                 check (role in ('Driller', 'Supervisor', 'Administrator')),
  badge_number text,
  created_at   timestamptz not null default now()
);

-- A row in auth.users with no profile would have no role, so every RLS check
-- against it would silently deny. Create the profile as part of signup.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, role, badge_number)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'role', 'Driller'),
    new.raw_user_meta_data ->> 'badge_number'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Read the caller's role without recursing through profiles' own RLS.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'Administrator'
  );
$$;

-- ---------------------------------------------------------------------------
-- Boreholes
-- ---------------------------------------------------------------------------

create table if not exists public.boreholes (
  id                        uuid primary key,
  name                      text not null,
  project                   text,
  client                    text,
  rig_name                  text,
  target_depth              numeric,
  current_depth             numeric,
  default_pipe_length       numeric,
  bit_diameter              numeric,
  bit_type                  text,
  -- Lossless: GPSCoordinates also carries accuracy and a fix timestamp that
  -- discrete lat/lng columns would quietly drop.
  gps                       jsonb,
  status                    text,
  created_at                timestamptz,
  updated_at                timestamptz,
  engine_hours_start        numeric,
  compressor_hours_start    numeric,
  current_engine_hours      numeric,
  current_compressor_hours  numeric,
  casing_installed_depth    numeric,
  created_by                uuid not null references auth.users (id),
  -- Device clock. Rig phones drift, so reports order by this but never trust it
  -- for bookkeeping.
  recorded_at               timestamptz not null,
  -- Server clock, assigned on arrival.
  received_at               timestamptz not null default now(),
  deleted_at                timestamptz
);

-- ---------------------------------------------------------------------------
-- Pipe records - the source of truth for depth
-- ---------------------------------------------------------------------------

create table if not exists public.pipe_records (
  id                   uuid primary key,
  borehole_id          uuid not null references public.boreholes (id) on delete cascade,
  pipe_number          integer not null,
  start_depth          numeric,
  end_depth            numeric,
  pipe_length          numeric,
  start_time           timestamptz,
  end_time             timestamptz,
  duration_seconds     integer,
  penetration_rate     numeric,
  formation            text,
  water_strike         boolean not null default false,
  water_strike_details jsonb,
  air_pressure         numeric,
  compressor_pressure  numeric,
  bit_type             text,
  bit_diameter         numeric,
  operator             text,
  remarks              text,
  gps                  jsonb,
  photo_path           text,
  created_by           uuid not null references auth.users (id),
  recorded_at          timestamptz not null,
  received_at          timestamptz not null default now(),
  deleted_at           timestamptz
);

create index if not exists pipe_records_borehole_idx
  on public.pipe_records (borehole_id, pipe_number);

-- ---------------------------------------------------------------------------
-- Drilling events (NPT and field operations)
-- ---------------------------------------------------------------------------

create table if not exists public.drilling_events (
  id              uuid primary key,
  borehole_id     uuid not null references public.boreholes (id) on delete cascade,
  type            text,
  title           text,
  occurred_at     timestamptz,
  depth_at_event  numeric,
  duration_minutes integer,
  is_npt          boolean not null default false,
  operator        text,
  details         jsonb,
  photo_path      text,
  created_by      uuid not null references auth.users (id),
  recorded_at     timestamptz not null,
  received_at     timestamptz not null default now(),
  deleted_at      timestamptz
);

create index if not exists drilling_events_borehole_idx
  on public.drilling_events (borehole_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Shift logs
-- ---------------------------------------------------------------------------

create table if not exists public.shift_logs (
  id                    uuid primary key,
  borehole_id           uuid not null references public.boreholes (id) on delete cascade,
  shift_date            date,
  shift_name            text,
  driller_name          text,
  supervisor_name       text,
  start_depth           numeric,
  end_depth             numeric,
  meters_drilled_today  numeric,
  productive_hours      numeric,
  non_productive_hours  numeric,
  fuel_used_liters      numeric,
  notes                 text,
  created_by            uuid not null references auth.users (id),
  recorded_at           timestamptz not null,
  received_at           timestamptz not null default now(),
  deleted_at            timestamptz
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
--
-- The update policy is what stops one crew overwriting another's work. A queued
-- upsert is INSERT .. ON CONFLICT DO UPDATE; when the conflicting row belongs to
-- someone else the UPDATE `using` clause fails and the write is rejected rather
-- than silently clobbering it.
--
-- No DELETE policy exists anywhere. Deletion is a soft delete (setting
-- deleted_at) so the audit trail survives.

alter table public.profiles        enable row level security;
alter table public.boreholes       enable row level security;
alter table public.pipe_records    enable row level security;
alter table public.drilling_events enable row level security;
alter table public.shift_logs      enable row level security;

-- Profiles: a user sees their own; admins see all.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (id = auth.uid() or public.is_admin());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

-- Records: authors read and write their own rows; admins read everything.
do $$
declare
  t text;
begin
  foreach t in array array['boreholes', 'pipe_records', 'drilling_events', 'shift_logs']
  loop
    execute format('drop policy if exists %I_select on public.%I', t, t);
    execute format(
      'create policy %I_select on public.%I for select using (created_by = auth.uid() or public.is_admin())',
      t, t);

    execute format('drop policy if exists %I_insert on public.%I', t, t);
    execute format(
      'create policy %I_insert on public.%I for insert with check (created_by = auth.uid())',
      t, t);

    execute format('drop policy if exists %I_update on public.%I', t, t);
    execute format(
      'create policy %I_update on public.%I for update using (created_by = auth.uid()) with check (created_by = auth.uid())',
      t, t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- Photo storage
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('drilling-photos', 'drilling-photos', false)
on conflict (id) do nothing;

-- Photos live under <uid>/<filename>, so ownership is a path prefix check.
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
