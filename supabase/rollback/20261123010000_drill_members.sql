-- Rollback of 20261123010000_drill_members.sql.
--
-- Run BEFORE the rollback of 20261123000000_saas_members.sql, and both
-- before the tenancy rollbacks; it assumes both are still applied.
--
-- The migration replaced five functions and added nothing else, so this puts
-- the five back: the legacy enrolment and shares_org_as() as drill_tenancy
-- defines them, and the foundation's defaults. No table, row, trigger or grant changes. No
-- transaction statements: the caller wraps it.
--
-- From the first statement on, every new account is enrolled in the founding
-- organization again, whatever its app_metadata says.

-- Exactly as in 20261116010000_drill_tenancy.sql (section 3).
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

-- Exactly as in 20261116010000_drill_tenancy.sql (section 7): an invited
-- membership of the target counts again.
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

-- The foundation's defaults, as 20261123000000_saas_members.sql creates them.
create or replace function public.saas_member_changing(
  org uuid, member uuid, change text, role text, badge text, status text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$ begin end $fn$;

create or replace function public.saas_member_record_count(org uuid, member uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $fn$ select 0::bigint $fn$;

create or replace function public.saas_roles()
returns text[]
language sql
stable
security definer
set search_path = public
as $fn$ select array['admin', 'member'] $fn$;
