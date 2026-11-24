-- Member management for Drill: what the reusable functions of
-- 20261123000000_saas_members.sql need to know about this application.
--
-- It replaces four functions and adds nothing else: no table, column,
-- trigger, policy or privilege. The trigger that calls one of them is
-- drill_tenancy's and stays as it is, so the tenancy rollback still takes
-- everything of its own away.
--
-- Re-runnable; each statement replaces one function in place and keeps its
-- grants. Rollback: supabase/rollback/20261123010000_drill_members.sql.

-- Drill's four roles, the same names memberships_role_check allows.
create or replace function public.saas_roles()
returns text[]
language sql
stable
security definer
set search_path = public
as $$ select array['Driller', 'Data Logger', 'Supervisor', 'Administrator'] $$;

-- Rows the member authored in the four record tables OF THAT ORGANIZATION,
-- soft-deleted ones included.
create or replace function public.saas_member_record_count(org uuid, member uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select (select count(*) from public.boreholes r       where r.org_id = org and r.created_by = member)
       + (select count(*) from public.pipe_records r    where r.org_id = org and r.created_by = member)
       + (select count(*) from public.drilling_events r where r.org_id = org and r.created_by = member)
       + (select count(*) from public.shift_logs r      where r.org_id = org and r.created_by = member);
$$;

-- An account created FOR an organization is not enrolled in the founding one.
--
-- The marker is the key `saas_org` in the account's app_metadata
-- (auth.users.raw_app_meta_data), which only the service role can write.
-- An account that carries the key at all, whatever its value, is never
-- enrolled by the legacy path: its memberships come from saas_add_member
-- only. user_metadata, which the user edits, is not looked at.
--
-- This is drill_tenancy's function (section 3) with that one test added to
-- its INSERT branch. The profile is created by the statement that creates
-- the account, so the founding membership is never there, not for a moment.
--
-- NOTE: drill_tenancy defines this function with CREATE OR REPLACE. Applying
-- that file again puts its version back, which enrols marked accounts; apply
-- this file again after it, as the order of the migrations does.
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
    if exists (
      select 1 from auth.users u
      where u.id = new.id and u.raw_app_meta_data ? 'saas_org'
    ) then
      return null;
    end if;

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

-- Copy-back: installed builds (1.1.7) read profiles.role and badge_number,
-- so a role or badge given to a FOUNDING membership through the member
-- functions is written to the profile too. No other organization's is.
--
-- This replaces the foundation's hook, which those functions call before
-- their own write; a direct write to memberships is not copied. Only the
-- column that changed is written, so a badge change never writes a role nor
-- a role change a badge. It does not loop with the mirror above: the write
-- here fires the mirror, which sets the membership to the value the member
-- function is about to write anyway, and nothing the mirror writes comes
-- back here, since this is not a trigger.
--
-- An 'invited' membership copies nothing, whichever change it is (add, role
-- or badge), and accepting it copies nothing either: the invited person may
-- belong to another company, and their profile is not this organization's
-- to change.
--
-- The ban mark (drill_tenancy, section 2): a membership deactivated through
-- saas_set_member_status or saas_remove_member is deactivated on purpose,
-- also when a ban had already deactivated it. The mark goes, so lifting the
-- ban later does not bring the member back.
create or replace function public.saas_member_changing(
  org uuid, member uuid, change text, role text, badge text, status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if change in ('status', 'remove') and saas_member_changing.status = 'deactivated' then
    update public.memberships m
    set deactivated_by_ban = false
    where m.org_id = org and m.user_id = member and m.deactivated_by_ban;
  end if;

  if org is distinct from public.founding_org_id()
     or saas_member_changing.status = 'invited' then
    return;
  end if;

  if change in ('add', 'role') then
    update public.profiles p set role = saas_member_changing.role where p.id = member;
  end if;
  if change in ('add', 'badge') then
    update public.profiles p set badge_number = badge where p.id = member;
  end if;
end;
$$;
