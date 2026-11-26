-- SaaS foundation, platform administration: the console's audit history with
-- names instead of bare ids. platform_audit(p_org, p_limit) returns audit_log
-- rows newest first (at, then id), for one organization when p_org is given,
-- at most p_limit rows (clamped to 1..1000), each with the actor's email, the
-- organization's name and, when the target is a user's id, that user's email
-- (null for any other target).
--
-- Reusable like saas_core: it names nothing that belongs to an application.
-- Refuses, with 42501, a caller who is not a signed-in platform administrator;
-- EXECUTE is for authenticated only (not public, anon or service_role).
--
-- Created together with its grants inside one DO block (see saas_platform).
-- Re-runnable. Rollback: supabase/rollback/20261126000000_saas_platform_audit.sql.

do $do$
begin
  create or replace function public.platform_audit(p_org uuid default null, p_limit integer default 200)
  returns table (id bigint, at timestamptz, actor_id uuid, actor_email text, org_id uuid, org_name text,
                 action text, target text, target_email text, details jsonb)
  language plpgsql
  stable
  security definer
  set search_path = public
  as $fn$
  begin
    if not public.is_platform_admin() then
      raise exception 'Platform administrators only.' using errcode = '42501';
    end if;
    -- The target is matched as text, so a target that is not a uuid finds no
    -- account and raises nothing.
    return query
      select a.id, a.at, a.actor_id, au.email::text, a.org_id, o.name,
             a.action, a.target, tu.email::text, a.details
      from public.audit_log a
      left join auth.users au on au.id = a.actor_id
      left join public.organizations o on o.id = a.org_id
      left join auth.users tu on tu.id::text = lower(a.target)
      where p_org is null or a.org_id = p_org
      order by a.at desc, a.id desc
      limit greatest(1, least(coalesce(p_limit, 200), 1000));
  end
  $fn$;

  revoke execute on function public.platform_audit(uuid, integer) from public, anon, service_role;
  grant execute on function public.platform_audit(uuid, integer) to authenticated;
end
$do$;
