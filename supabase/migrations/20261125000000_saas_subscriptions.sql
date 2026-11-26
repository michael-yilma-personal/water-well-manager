-- SaaS foundation, subscriptions: plans, one subscription per organization,
-- the access level it gives, and the user limit.
--
-- Reusable like saas_core: it names nothing that belongs to an application.
-- Clients only read these tables; a subscription is changed by the service
-- role or by SQL.
--
-- Refusal, with its own SQLSTATE:
--   SS001  the organization's user limit is reached (raised by the trigger on
--          memberships, so it comes unchanged through saas_add_member too)
--
-- Tables and functions are created together with their grants inside one DO
-- block, which is one statement (see saas_core and saas_members for why).
--
-- Re-runnable. Rollback: supabase/rollback/20261125000000_saas_subscriptions.sql.
-- After this file saas_core cannot be applied again until it is rolled back:
-- my_organizations() has two more columns than saas_core creates it with.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

do $do$
declare
  first_run boolean := to_regclass('public.subscriptions') is null;
begin
  create table if not exists public.plans (
    id        text primary key,
    name      text not null,
    max_users integer not null,
    features  jsonb not null default '{}',
    is_active boolean not null default true
  );

  -- One row per organization holds the current state; its history is the
  -- audit log.
  create table if not exists public.subscriptions (
    org_id             uuid primary key references public.organizations (id),
    plan_id            text not null references public.plans (id),
    status             text not null
                         check (status in ('trial', 'active', 'suspended', 'canceled')),
    starts_at          timestamptz not null default now(),
    -- null = no end date
    ends_at            timestamptz,
    grace_days         integer not null default 7,
    max_users_override integer,
    features_override  jsonb,
    notes              text
  );

  alter table public.plans         enable row level security;
  alter table public.subscriptions enable row level security;

  revoke all on public.plans, public.subscriptions from anon, authenticated;
  grant select on public.plans, public.subscriptions to authenticated;
  grant all on public.plans, public.subscriptions to service_role;

  insert into public.plans (id, name, max_users)
  values ('standard', 'Standard', 100)
  on conflict (id) do nothing;

  -- Only the first time: every organization that exists gets a subscription,
  -- so nothing changes for it. Applied again, an organization without a row
  -- stays without one (no row means no access).
  if first_run then
    insert into public.subscriptions (org_id, plan_id, status)
    select o.id, 'standard', 'active' from public.organizations o;
  end if;
end
$do$;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

do $do$
begin
  -- 'full', 'read_only' or 'none'. A trial or active subscription gives full
  -- access until its end date plus its days of grace, and read-only access
  -- after that. Suspended, canceled or no subscription row: none.
  create or replace function public.org_access(org uuid)
  returns text
  language sql
  stable
  security definer
  set search_path = public
  as $fn$
    select coalesce((
      select case
               when s.status not in ('trial', 'active') then 'none'
               when s.ends_at is null
                 or now() <= s.ends_at + make_interval(days => s.grace_days) then 'full'
               else 'read_only'
             end
      from public.subscriptions s
      where s.org_id = org), 'none');
  $fn$;

  -- As in saas_core, with the organization's access level and end date. The
  -- return type changes, so it is dropped rather than replaced.
  drop function if exists public.my_organizations();
  create function public.my_organizations()
  returns table (org_id uuid, name text, role text, status text, access text, ends_at timestamptz)
  language sql
  stable
  security definer
  set search_path = public
  as $fn$
    select m.org_id, o.name, m.role, m.status, public.org_access(m.org_id), s.ends_at
    from public.memberships m
    join public.organizations o on o.id = m.org_id
    left join public.subscriptions s on s.org_id = m.org_id
    where m.user_id = auth.uid();
  $fn$;

  -- The user limit: 'active' and 'invited' memberships count, against the
  -- subscription's override or else its plan's max_users. An organization
  -- without a subscription row has no limit (and no access).
  --
  -- It runs after the row is written and first locks the organization's row,
  -- the lock the member functions take: of two inserts at the same moment the
  -- second waits here, then counts what the first committed (READ COMMITTED).
  create or replace function public.saas_enforce_user_limit()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
  as $fn$
  declare
    lim integer;
  begin
    -- Only a membership that starts to count is checked.
    if new.status = 'deactivated'
       or (tg_op = 'UPDATE' and old.org_id = new.org_id and old.status <> 'deactivated') then
      return null;
    end if;

    perform 1 from public.organizations o where o.id = new.org_id for no key update;

    select coalesce(s.max_users_override, p.max_users) into lim
    from public.subscriptions s
    join public.plans p on p.id = s.plan_id
    where s.org_id = new.org_id;

    if (select count(*) from public.memberships m
        where m.org_id = new.org_id and m.status <> 'deactivated') > lim then
      raise exception 'The organization''s user limit (%) is reached.', lim
        using errcode = 'SS001';
    end if;
    return null;
  end
  $fn$;

  revoke execute on function public.org_access(uuid), public.my_organizations()
    from public, anon;
  grant execute on function public.org_access(uuid), public.my_organizations()
    to authenticated, service_role;
  revoke execute on function public.saas_enforce_user_limit()
    from public, anon, authenticated;

  drop trigger if exists memberships_user_limit on public.memberships;
  create trigger memberships_user_limit
    after insert or update on public.memberships
    for each row execute function public.saas_enforce_user_limit();
end
$do$;

-- ---------------------------------------------------------------------------
-- Read policies
-- ---------------------------------------------------------------------------

drop policy if exists plans_select on public.plans;
create policy plans_select on public.plans
  for select to authenticated
  using (true);

-- An active member reads their own organization's subscription.
drop policy if exists subscriptions_select on public.subscriptions;
create policy subscriptions_select on public.subscriptions
  for select to authenticated
  using (public.is_org_member(org_id));
