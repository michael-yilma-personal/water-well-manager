-- SaaS foundation, platform administration: the functions behind the platform
-- console. Two change things (create an organization with its subscription;
-- change a subscription) and two read (the organizations; one organization's
-- members). The audit history is read from audit_log through its own policy.
--
-- Reusable like saas_core: it names nothing that belongs to an application.
--
-- Each function refuses, with 42501, a caller who is not a signed-in platform
-- administrator; the service role is not one and holds no EXECUTE either. A
-- change and its audit row are one transaction. Other refusals are 22023
-- (a status, an action or an argument the function does not take, or no
-- subscription); an unknown plan is refused by the foreign key (23503).
--
-- The audit row of a subscription change carries the row before and after
-- WITHOUT its notes: an organization's administrators read their
-- organization's audit rows, and the notes are the platform's own.
--
-- Functions are created together with their grants inside one DO block,
-- which is one statement (see saas_core and saas_members for why).
--
-- Re-runnable. Rollback: supabase/rollback/20261125020000_saas_platform.sql.

do $do$
begin
  -- A new organization with its subscription, 'trial' or 'active'. Returns
  -- the organization's id.
  create or replace function public.platform_create_organization(
    p_name text, p_plan text, p_status text, p_ends_at timestamptz default null)
  returns uuid
  language plpgsql
  security definer
  set search_path = public
  as $fn$
  declare
    org uuid;
  begin
    if not public.is_platform_admin() then
      raise exception 'Platform administrators only.' using errcode = '42501';
    end if;
    if p_status is null or p_status not in ('trial', 'active') then
      raise exception 'An organization is created as trial or active.' using errcode = '22023';
    end if;

    insert into public.organizations (name) values (p_name) returning id into org;
    insert into public.subscriptions (org_id, plan_id, status, ends_at)
    values (org, p_plan, p_status, p_ends_at);

    insert into public.audit_log (actor_id, org_id, action, details)
    values (auth.uid(), org, 'org.create',
            jsonb_build_object('plan', p_plan, 'status', p_status, 'ends_at', p_ends_at));
    return org;
  end
  $fn$;

  -- One action on an organization's subscription. No transition between
  -- statuses is forbidden. p_args:
  --   start_trial   ends_at, optional (JSON null: no end date)
  --   extend        ends_at, required
  --   change_plan   plan, required
  --   override      max_users, features: at least one; a key that is present
  --                 is set, JSON null clears it, an absent key is left alone
  --   activate, suspend, reactivate, cancel   nothing
  --   any action    notes, optional
  create or replace function public.platform_update_subscription(
    p_org uuid, p_action text, p_args jsonb default '{}')
  returns void
  language plpgsql
  security definer
  set search_path = public
  as $fn$
  declare
    b public.subscriptions;
    a public.subscriptions;
  begin
    if not public.is_platform_admin() then
      raise exception 'Platform administrators only.' using errcode = '42501';
    end if;

    select * into b from public.subscriptions s where s.org_id = p_org for no key update;
    if not found then
      raise exception 'The organization has no subscription.' using errcode = '22023';
    end if;
    a := b;

    case p_action
      when 'start_trial' then
        a.status := 'trial';
        if p_args ? 'ends_at' then
          a.ends_at := (p_args ->> 'ends_at')::timestamptz;
        end if;
      when 'activate', 'reactivate' then
        a.status := 'active';
      when 'suspend' then
        a.status := 'suspended';
      when 'cancel' then
        a.status := 'canceled';
      when 'extend' then
        if p_args ->> 'ends_at' is null then
          raise exception 'extend needs ends_at.' using errcode = '22023';
        end if;
        a.ends_at := (p_args ->> 'ends_at')::timestamptz;
      when 'change_plan' then
        if p_args ->> 'plan' is null then
          raise exception 'change_plan needs plan.' using errcode = '22023';
        end if;
        a.plan_id := p_args ->> 'plan';
      when 'override' then
        if not p_args ?| array['max_users', 'features'] then
          raise exception 'override needs max_users or features.' using errcode = '22023';
        end if;
        if p_args ? 'max_users' then
          a.max_users_override := (p_args ->> 'max_users')::integer;
        end if;
        if p_args ? 'features' then
          a.features_override := nullif(p_args -> 'features', 'null');
        end if;
      else
        raise exception 'Unknown action.' using errcode = '22023';
    end case;
    if p_args ? 'notes' then
      a.notes := p_args ->> 'notes';
    end if;

    update public.subscriptions s
    set plan_id = a.plan_id, status = a.status, ends_at = a.ends_at,
        max_users_override = a.max_users_override,
        features_override = a.features_override, notes = a.notes
    where s.org_id = p_org;

    insert into public.audit_log (actor_id, org_id, action, details)
    values (auth.uid(), p_org, 'subscription.' || p_action,
            jsonb_build_object('before', to_jsonb(b) - 'notes', 'after', to_jsonb(a) - 'notes'));
  end
  $fn$;

  -- Every organization with its subscription (null where it has none), its
  -- access level, and the members that count against its user limit.
  create or replace function public.platform_organizations()
  returns table (org_id uuid, name text, created_at timestamptz, plan_id text, status text,
                 starts_at timestamptz, ends_at timestamptz, grace_days integer,
                 max_users_override integer, features_override jsonb, notes text,
                 access text, members bigint)
  language plpgsql
  stable
  security definer
  set search_path = public
  as $fn$
  begin
    if not public.is_platform_admin() then
      raise exception 'Platform administrators only.' using errcode = '42501';
    end if;
    return query
      select o.id, o.name, o.created_at, s.plan_id, s.status, s.starts_at, s.ends_at, s.grace_days,
             s.max_users_override, s.features_override, s.notes, public.org_access(o.id),
             (select count(*) from public.memberships m
              where m.org_id = o.id and m.status <> 'deactivated')
      from public.organizations o
      left join public.subscriptions s on s.org_id = o.id
      order by o.name;
  end
  $fn$;

  -- Every member of one organization, whatever the status. The name is the
  -- account's user metadata "name" (null when it has none).
  create or replace function public.platform_members(p_org uuid)
  returns table (user_id uuid, name text, email text, role text, status text)
  language plpgsql
  stable
  security definer
  set search_path = public
  as $fn$
  begin
    if not public.is_platform_admin() then
      raise exception 'Platform administrators only.' using errcode = '42501';
    end if;
    return query
      select m.user_id, u.raw_user_meta_data ->> 'name', u.email::text, m.role, m.status
      from public.memberships m
      join auth.users u on u.id = m.user_id
      where m.org_id = p_org
      order by 2, 3;
  end
  $fn$;

  revoke execute on function
    public.platform_create_organization(text, text, text, timestamptz),
    public.platform_update_subscription(uuid, text, jsonb),
    public.platform_organizations(), public.platform_members(uuid)
    from public, anon, service_role;
  grant execute on function
    public.platform_create_organization(text, text, text, timestamptz),
    public.platform_update_subscription(uuid, text, jsonb),
    public.platform_organizations(), public.platform_members(uuid)
    to authenticated;
end
$do$;
