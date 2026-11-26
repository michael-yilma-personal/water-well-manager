-- Rollback of 20261125000000_saas_subscriptions.sql.
--
-- Run BEFORE the member and tenancy rollbacks (newest first). This DELETES
-- every plan and subscription; memberships stay. my_organizations() is put
-- back as saas_core creates it, grants included. No transaction statements:
-- the caller wraps it.

drop trigger if exists memberships_user_limit on public.memberships;
drop function if exists public.saas_enforce_user_limit();

-- One statement, so the function is never there with the wrong grants.
do $do$
begin
  drop function if exists public.my_organizations();
  create function public.my_organizations()
  returns table (org_id uuid, name text, role text, status text)
  language sql
  stable
  security definer
  set search_path = public
  -- The body is saas_core's to the byte, indentation included.
  as $fn$
  select m.org_id, o.name, m.role, m.status
  from public.memberships m
  join public.organizations o on o.id = m.org_id
  where m.user_id = auth.uid();
$fn$;

  grant execute on function public.my_organizations() to authenticated, service_role;
  revoke execute on function public.my_organizations() from public, anon;
end
$do$;

drop function if exists public.org_access(uuid);
drop table if exists public.subscriptions;
drop table if exists public.plans;
