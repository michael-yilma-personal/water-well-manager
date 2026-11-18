-- Rollback of 20261116000000_saas_core.sql.
--
-- Run AFTER the rollback of 20261116010000_drill_tenancy.sql. While that
-- migration is still applied the record tables reference organizations and
-- this script fails on purpose: there is no CASCADE here, so it can never
-- take application data with it.
--
-- This DELETES every organization, membership, platform administrator and
-- audit row. No transaction statements: the caller wraps it.

-- Tables first: their policies depend on the functions.
drop table if exists public.audit_log;
drop table if exists public.platform_admins;
drop table if exists public.memberships;
drop table if exists public.organizations;

drop function if exists public.my_organizations();
drop function if exists public.is_platform_admin();
drop function if exists public.is_org_admin(uuid);
drop function if exists public.saas_admin_roles();
drop function if exists public.has_org_role(uuid, text[]);
drop function if exists public.is_org_member(uuid);
