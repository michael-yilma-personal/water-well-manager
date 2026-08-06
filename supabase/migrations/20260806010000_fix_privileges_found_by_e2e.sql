-- Two holes that only showed up when the policies were exercised against a
-- live project with real signed-in users.
--
-- 1. Self-promotion was still possible.
--
--    20260806000000 tried `revoke update (role) ... from authenticated`, but
--    Supabase grants table-level UPDATE on public tables, and a table-level
--    grant covers every column. A column-level revoke does not subtract from
--    it, so the statement was a silent no-op and a driller could still PATCH
--    their own role to Administrator - which grants read access to every
--    crew's data, since every policy trusts profiles.role via is_admin().
--
--    The working form is to drop the table grant and re-grant only the columns
--    a user may edit.
--
-- 2. Administrators could write field data.
--
--    The insert policy only required `created_by = auth.uid()`, which an admin
--    trivially satisfies. Administrators are meant to read the drilling record,
--    not author it; letting them insert pipe records means the log that backs
--    client billing can be written by someone who was never at the rig.

-- --- 1. Profiles: role is not self-editable -------------------------------

revoke update on public.profiles from authenticated;
revoke update on public.profiles from anon;

-- A user may still maintain their own display name and badge.
grant update (name, badge_number) on public.profiles to authenticated;

-- Deletion is soft everywhere in this schema; nobody needs the hard kind.
revoke delete on public.profiles from authenticated;
revoke delete on public.profiles from anon;

-- --- 2. Administrators read the record, they do not write it ---------------

do $$
declare
  t text;
begin
  foreach t in array array['boreholes', 'pipe_records', 'drilling_events', 'shift_logs']
  loop
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

    -- No delete policy exists, but the blanket table grant should go too.
    execute format('revoke delete on public.%I from authenticated', t);
    execute format('revoke delete on public.%I from anon', t);
  end loop;
end
$$;
