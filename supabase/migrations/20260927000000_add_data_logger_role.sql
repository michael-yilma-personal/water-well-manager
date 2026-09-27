-- Add the Data Logger role.
--
-- A Data Logger records pipes, formations, events and photos on a rig, exactly
-- as a Driller does, under their own name. No policy needs to change: every
-- write policy keys off created_by = auth.uid() and not is_admin(), and every
-- read policy off created_by = auth.uid() or is_admin(), so a non-admin role is
-- a crew role by construction. Only the allowed values widen.
--
-- The signup trigger still creates every profile as a Driller; Data Logger is
-- assigned out of band like any other role (see 20260806000000).

alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('Driller', 'Data Logger', 'Supervisor', 'Administrator'));
