-- SaaS foundation, member management: the functions through which an
-- organization's memberships are added, changed and removed, and through
-- which an invited person accepts or declines.
--
-- Reusable like saas_core: it names nothing that belongs to an application.
-- An application's own migration replaces three functions (section 1).
--
-- The five management functions are for the service role only. Their one
-- caller is an Edge Function, and IT decides whether the acting user may
-- administer the organization; they only record the actor, apply the rules
-- that hold whoever asks, and write one audit row with the change.
-- accept_membership() and decline_membership() are for signed-in users and
-- act on the caller's own invitation. A signed-out client may execute none.
--
-- Refusals, each with its own SQLSTATE:
--   SM001  no such organization (saas_add_member)
--   SM002  the role is not one of saas_roles()
--   SM003  already a member of the organization, whatever the status
--   SM004  no membership of that user in the organization
--   SM005  the member is the actor
--   SM006  the organization would be left without an active administrator
--   SM007  the membership is an invitation: accepted or removed, nothing else
--   SM008  the status is not one the function takes
--   42501  accept / decline: the caller has no invitation there
--
-- Functions are created together with their grants inside one DO block,
-- which is one statement: a hosted Supabase project hands every new function
-- to the API roles the moment it is created, and applied one statement at a
-- time any signed-in user could otherwise call them in between.
--
-- Re-runnable. Rollback: supabase/rollback/20261123000000_saas_members.sql.

-- ---------------------------------------------------------------------------
-- 1. What an application replaces
-- ---------------------------------------------------------------------------
--
-- Created only when absent: applying this file again must not put a default
-- back underneath an application's replacement.
--   saas_roles()                 the role names a membership may carry
--   saas_member_record_count()   how many records the member authored in the
--                                organization; decides whether a removal
--                                deletes the membership or deactivates it
--   saas_member_changing()       a hook: called by saas_add_member ('add'),
--                                saas_set_member_role ('role'),
--                                saas_set_member_badge ('badge'),
--                                saas_set_member_status ('status') and, when
--                                it deactivates, saas_remove_member
--                                ('remove'), after their checks and before
--                                their write, with the role, badge and status
--                                the membership is about to have. The default
--                                does nothing.
do $do$
begin
  if to_regprocedure('public.saas_roles()') is null then
    create function public.saas_roles()
    returns text[]
    language sql
    stable
    security definer
    set search_path = public
    as $fn$ select array['admin', 'member'] $fn$;
  end if;

  if to_regprocedure('public.saas_member_record_count(uuid, uuid)') is null then
    create function public.saas_member_record_count(org uuid, member uuid)
    returns bigint
    language sql
    stable
    security definer
    set search_path = public
    as $fn$ select 0::bigint $fn$;
  end if;

  if to_regprocedure('public.saas_member_changing(uuid, uuid, text, text, text, text)') is null then
    create function public.saas_member_changing(
      org uuid, member uuid, change text, role text, badge text, status text)
    returns void
    language plpgsql
    security definer
    set search_path = public
    as $fn$ begin end $fn$;
  end if;

  revoke execute on function public.saas_roles() from public, anon;
  grant execute on function public.saas_roles() to authenticated, service_role;

  revoke execute on function public.saas_member_record_count(uuid, uuid),
    public.saas_member_changing(uuid, uuid, text, text, text, text)
    from public, anon, authenticated;
  grant execute on function public.saas_member_record_count(uuid, uuid),
    public.saas_member_changing(uuid, uuid, text, text, text, text)
    to service_role;
end
$do$;

-- ---------------------------------------------------------------------------
-- 2. The functions
-- ---------------------------------------------------------------------------
--
-- Each management function first locks the organization's row until its
-- transaction ends, so two changes to one organization's members never
-- overlap: the second waits, and then reads what the first committed (READ
-- COMMITTED, the default and what the API uses). That is what makes the
-- last-administrator rule hold between two sessions; a count alone would
-- let each of two requests see the other administrator still in place.
-- FOR NO KEY UPDATE conflicts with itself but not with the lock an insert of
-- a row referencing the organization takes, so recording data never waits.
--
-- The last-administrator rule refuses only the change that takes an
-- organization from having an active administrator to having none.
--
-- A parameter that shares its name with a column is written with the
-- function's name in front wherever a column could be meant.
do $do$
begin
  -- A new membership, 'active' or 'invited'. An invitation gives nothing
  -- until the invited person accepts it.
  create or replace function public.saas_add_member(
    org uuid, member uuid, role text, badge text, status text, actor uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
  as $fn$
  begin
    perform 1 from public.organizations o where o.id = org for no key update;
    if not found then
      raise exception 'No such organization.' using errcode = 'SM001';
    end if;
    if saas_add_member.role is null
       or not (saas_add_member.role = any (public.saas_roles())) then
      raise exception 'Unknown role.' using errcode = 'SM002';
    end if;
    if saas_add_member.status is null
       or saas_add_member.status not in ('active', 'invited') then
      raise exception 'A member is added as active or invited.' using errcode = 'SM008';
    end if;
    if exists (select 1 from public.memberships x where x.org_id = org and x.user_id = member) then
      raise exception 'Already a member of this organization.' using errcode = 'SM003';
    end if;

    perform public.saas_member_changing(org, member, 'add',
      saas_add_member.role, badge, saas_add_member.status);

    insert into public.memberships (org_id, user_id, role, status, badge_number)
    values (org, member, saas_add_member.role, saas_add_member.status, badge);

    insert into public.audit_log (actor_id, org_id, action, target, details)
    values (actor, org, 'member.add', member::text,
            jsonb_build_object('role', saas_add_member.role, 'badge', badge,
                               'status', saas_add_member.status));
  end
  $fn$;

  create or replace function public.saas_set_member_role(
    org uuid, member uuid, role text, actor uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
  as $fn$
  declare
    m public.memberships;
  begin
    perform 1 from public.organizations o where o.id = org for no key update;

    if saas_set_member_role.role is null
       or not (saas_set_member_role.role = any (public.saas_roles())) then
      raise exception 'Unknown role.' using errcode = 'SM002';
    end if;
    select x.* into m from public.memberships x where x.org_id = org and x.user_id = member;
    if not found then
      raise exception 'No such member in this organization.' using errcode = 'SM004';
    end if;
    if member = actor then
      raise exception 'A member cannot change their own role.' using errcode = 'SM005';
    end if;
    if m.status = 'active' and m.role = any (public.saas_admin_roles())
       and not (saas_set_member_role.role = any (public.saas_admin_roles()))
       and not exists (
         select 1 from public.memberships x
         where x.org_id = org and x.user_id <> member and x.status = 'active'
           and x.role = any (public.saas_admin_roles())) then
      raise exception 'The organization would be left without an active administrator.'
        using errcode = 'SM006';
    end if;

    perform public.saas_member_changing(org, member, 'role',
      saas_set_member_role.role, m.badge_number, m.status);

    update public.memberships x
    set role = saas_set_member_role.role
    where x.org_id = org and x.user_id = member;

    insert into public.audit_log (actor_id, org_id, action, target, details)
    values (actor, org, 'member.role', member::text,
            jsonb_build_object('from', m.role, 'to', saas_set_member_role.role));
  end
  $fn$;

  -- No self rule: a badge gives nothing.
  create or replace function public.saas_set_member_badge(
    org uuid, member uuid, badge text, actor uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
  as $fn$
  declare
    m public.memberships;
  begin
    perform 1 from public.organizations o where o.id = org for no key update;

    select x.* into m from public.memberships x where x.org_id = org and x.user_id = member;
    if not found then
      raise exception 'No such member in this organization.' using errcode = 'SM004';
    end if;

    perform public.saas_member_changing(org, member, 'badge', m.role, badge, m.status);

    update public.memberships x
    set badge_number = badge
    where x.org_id = org and x.user_id = member;

    insert into public.audit_log (actor_id, org_id, action, target, details)
    values (actor, org, 'member.badge', member::text,
            jsonb_build_object('from', m.badge_number, 'to', badge));
  end
  $fn$;

  -- 'active' or 'deactivated'. The account itself is never touched.
  create or replace function public.saas_set_member_status(
    org uuid, member uuid, status text, actor uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
  as $fn$
  declare
    m public.memberships;
  begin
    perform 1 from public.organizations o where o.id = org for no key update;

    if saas_set_member_status.status is null
       or saas_set_member_status.status not in ('active', 'deactivated') then
      raise exception 'A member is set active or deactivated.' using errcode = 'SM008';
    end if;
    select x.* into m from public.memberships x where x.org_id = org and x.user_id = member;
    if not found then
      raise exception 'No such member in this organization.' using errcode = 'SM004';
    end if;
    if member = actor then
      raise exception 'A member cannot change their own status.' using errcode = 'SM005';
    end if;
    if m.status = 'invited' then
      raise exception 'An invitation is accepted by the invited person or removed, not activated or deactivated.'
        using errcode = 'SM007';
    end if;
    if saas_set_member_status.status = 'deactivated'
       and m.status = 'active' and m.role = any (public.saas_admin_roles())
       and not exists (
         select 1 from public.memberships x
         where x.org_id = org and x.user_id <> member and x.status = 'active'
           and x.role = any (public.saas_admin_roles())) then
      raise exception 'The organization would be left without an active administrator.'
        using errcode = 'SM006';
    end if;

    perform public.saas_member_changing(org, member, 'status',
      m.role, m.badge_number, saas_set_member_status.status);

    update public.memberships x
    set status = saas_set_member_status.status
    where x.org_id = org and x.user_id = member;

    insert into public.audit_log (actor_id, org_id, action, target, details)
    values (actor, org, 'member.status', member::text,
            jsonb_build_object('from', m.status, 'to', saas_set_member_status.status));
  end
  $fn$;

  -- Returns 'removed' when the membership row was deleted (the member
  -- authored nothing in this organization) and 'deactivated' when it was
  -- kept, deactivated. An invitation can be removed. The account itself is
  -- never touched.
  create or replace function public.saas_remove_member(org uuid, member uuid, actor uuid)
  returns text
  language plpgsql
  security definer
  set search_path = public
  as $fn$
  declare
    m public.memberships;
    records bigint;
    outcome text;
  begin
    perform 1 from public.organizations o where o.id = org for no key update;

    select x.* into m from public.memberships x where x.org_id = org and x.user_id = member;
    if not found then
      raise exception 'No such member in this organization.' using errcode = 'SM004';
    end if;
    if member = actor then
      raise exception 'A member cannot remove themselves.' using errcode = 'SM005';
    end if;
    if m.status = 'active' and m.role = any (public.saas_admin_roles())
       and not exists (
         select 1 from public.memberships x
         where x.org_id = org and x.user_id <> member and x.status = 'active'
           and x.role = any (public.saas_admin_roles())) then
      raise exception 'The organization would be left without an active administrator.'
        using errcode = 'SM006';
    end if;

    records := public.saas_member_record_count(org, member);
    if records = 0 then
      outcome := 'removed';
      delete from public.memberships x where x.org_id = org and x.user_id = member;
    else
      outcome := 'deactivated';
      perform public.saas_member_changing(org, member, 'remove', m.role, m.badge_number, 'deactivated');
      update public.memberships x
      set status = 'deactivated'
      where x.org_id = org and x.user_id = member;
    end if;

    insert into public.audit_log (actor_id, org_id, action, target, details)
    values (actor, org, 'member.remove', member::text,
            jsonb_build_object('outcome', outcome, 'records', records));
    return outcome;
  end
  $fn$;

  -- Invitations. The caller is auth.uid() and nothing else, and only an
  -- 'invited' membership is touched, so neither function reaches anyone
  -- else's membership or brings a deactivated member back. They take the
  -- organization's lock like the functions above.
  create or replace function public.accept_membership(org uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
  as $fn$
  begin
    perform 1 from public.organizations o where o.id = org for no key update;

    update public.memberships x
    set status = 'active'
    where x.org_id = org and x.user_id = auth.uid() and x.status = 'invited';
    if not found then
      raise exception 'You have no invitation to this organization.' using errcode = '42501';
    end if;

    insert into public.audit_log (actor_id, org_id, action, target)
    values (auth.uid(), org, 'membership.accept', auth.uid()::text);
  end
  $fn$;

  create or replace function public.decline_membership(org uuid)
  returns void
  language plpgsql
  security definer
  set search_path = public
  as $fn$
  begin
    perform 1 from public.organizations o where o.id = org for no key update;

    delete from public.memberships x
    where x.org_id = org and x.user_id = auth.uid() and x.status = 'invited';
    if not found then
      raise exception 'You have no invitation to this organization.' using errcode = '42501';
    end if;

    insert into public.audit_log (actor_id, org_id, action, target)
    values (auth.uid(), org, 'membership.decline', auth.uid()::text);
  end
  $fn$;

  revoke execute on function
    public.saas_add_member(uuid, uuid, text, text, text, uuid),
    public.saas_set_member_role(uuid, uuid, text, uuid),
    public.saas_set_member_badge(uuid, uuid, text, uuid),
    public.saas_set_member_status(uuid, uuid, text, uuid),
    public.saas_remove_member(uuid, uuid, uuid)
    from public, anon, authenticated;
  grant execute on function
    public.saas_add_member(uuid, uuid, text, text, text, uuid),
    public.saas_set_member_role(uuid, uuid, text, uuid),
    public.saas_set_member_badge(uuid, uuid, text, uuid),
    public.saas_set_member_status(uuid, uuid, text, uuid),
    public.saas_remove_member(uuid, uuid, uuid)
    to service_role;

  revoke execute on function public.accept_membership(uuid), public.decline_membership(uuid)
    from public, anon;
  grant execute on function public.accept_membership(uuid), public.decline_membership(uuid)
    to authenticated, service_role;
end
$do$;
