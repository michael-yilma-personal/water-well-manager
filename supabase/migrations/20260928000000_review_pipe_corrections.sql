-- Let the crew and the office correct a saved pipe record.
--
-- A pipe is saved at the rig, often in a hurry: the wrong formation or bit
-- picked from a list, a pressure mistyped, a remark left out. Until now only
-- the author could change their record, and only from the phone that logged
-- it; the office could see a mistake but not fix it before the report went to
-- the client.
--
-- Who may change what:
--   - The author (Driller, Data Logger, Supervisor) may update their own
--     records, as before.
--   - A reviewer - Supervisor or Administrator - may correct anyone's pipe
--     record, but only the fields entered on the End Pipe sheet: formation,
--     bit, pressures, water strike and remarks. Depths, times, the operator
--     and deletion stay with the author; they are measurements that back
--     client billing, and an office correction must never move a hole deeper.
--   - Administrators still cannot create field data (20260806010000).
--
-- Supervisors could previously read only their own rows. Correcting the
-- crew's work means reading it, so reviewers now read every crew's records,
-- as administrators already did. Field devices do not widen with it: the pull
-- filters on created_by itself rather than trusting RLS to scope it.

-- ---------------------------------------------------------------------------
-- Reviewer role
-- ---------------------------------------------------------------------------

create or replace function public.is_reviewer()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('Supervisor', 'Administrator')
  );
$$;

-- ---------------------------------------------------------------------------
-- Reads: reviewers see every crew
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
  end loop;
end
$$;

-- Names for "logged by" and "corrected by" on the dashboard.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select using (id = auth.uid() or public.is_reviewer());

-- ---------------------------------------------------------------------------
-- Pipe records: reviewers may update, within the guard below
-- ---------------------------------------------------------------------------

drop policy if exists pipe_records_update on public.pipe_records;
create policy pipe_records_update on public.pipe_records
  for update
  using ((created_by = auth.uid() and not public.is_admin()) or public.is_reviewer())
  with check ((created_by = auth.uid() and not public.is_admin()) or public.is_reviewer());

alter table public.pipe_records
  add column if not exists edited_by uuid references auth.users (id) on delete set null,
  add column if not exists edited_at timestamptz;

-- RLS decides which rows; this decides which columns, and stamps who last
-- changed an End Pipe field. A re-sent upsert from the phone that changes
-- nothing leaves the stamp alone, so a retry never reads as a correction.
create or replace function public.pipe_records_guard_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if auth.uid() is not null and auth.uid() <> old.created_by then
    if (new.borehole_id, new.pipe_number, new.start_depth, new.end_depth,
        new.pipe_length, new.start_time, new.end_time, new.duration_seconds,
        new.paused_seconds, new.pauses, new.penetration_rate, new.operator,
        new.gps, new.photo_path, new.created_by, new.recorded_at,
        new.received_at, new.deleted_at)
       is distinct from
       (old.borehole_id, old.pipe_number, old.start_depth, old.end_depth,
        old.pipe_length, old.start_time, old.end_time, old.duration_seconds,
        old.paused_seconds, old.pauses, old.penetration_rate, old.operator,
        old.gps, old.photo_path, old.created_by, old.recorded_at,
        old.received_at, old.deleted_at)
    then
      raise exception 'Only the author can change depth, time, operator or delete a pipe record. Reviewers may correct formation, bit, pressures, water strike and remarks.'
        using errcode = '42501';
    end if;
  end if;

  if (new.formation, new.bit_type, new.bit_diameter, new.air_pressure,
      new.compressor_pressure, new.water_strike, new.water_strike_details,
      new.remarks)
     is distinct from
     (old.formation, old.bit_type, old.bit_diameter, old.air_pressure,
      old.compressor_pressure, old.water_strike, old.water_strike_details,
      old.remarks)
  then
    new.edited_by := coalesce(auth.uid(), old.edited_by);
    new.edited_at := now();
  else
    new.edited_by := old.edited_by;
    new.edited_at := old.edited_at;
  end if;
  return new;
end;
$$;

drop trigger if exists pipe_records_guard_update on public.pipe_records;
create trigger pipe_records_guard_update
  before update on public.pipe_records
  for each row execute function public.pipe_records_guard_update();

-- ---------------------------------------------------------------------------
-- modified_at: so a correction reaches the phone
-- ---------------------------------------------------------------------------
--
-- Devices pulled by received_at, which is set once at insert. An update - an
-- office correction, or the same driller editing from a second phone - never
-- moved it, so the change was never downloaded, and the phone kept printing
-- the uncorrected record on its reports. modified_at moves on every write.
-- Backfilled from received_at, so a device's existing watermark stays valid.

do $$
declare
  t text;
begin
  foreach t in array array['boreholes', 'pipe_records', 'drilling_events', 'shift_logs']
  loop
    execute format('alter table public.%I add column if not exists modified_at timestamptz', t);
    execute format('update public.%I set modified_at = received_at where modified_at is null', t);
    execute format('alter table public.%I alter column modified_at set default now()', t);
    execute format('alter table public.%I alter column modified_at set not null', t);
    execute format(
      'create index if not exists %I on public.%I (modified_at)',
      t || '_modified_at_idx', t);
  end loop;
end
$$;

create or replace function public.touch_modified_at()
returns trigger
language plpgsql
as $$
begin
  new.modified_at := now();
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array['boreholes', 'pipe_records', 'drilling_events', 'shift_logs']
  loop
    execute format('drop trigger if exists %I on public.%I', t || '_touch_modified_at', t);
    execute format(
      'create trigger %I before insert or update on public.%I '
      'for each row execute function public.touch_modified_at()',
      t || '_touch_modified_at', t);
  end loop;
end
$$;
