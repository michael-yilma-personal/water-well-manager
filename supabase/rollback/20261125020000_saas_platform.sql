-- Rollback of 20261125020000_saas_platform.sql.
--
-- Run FIRST (newest first), before the subscriptions rollbacks. Drops the
-- four platform functions and nothing else: the organizations, subscriptions
-- and audit rows they wrote stay. No transaction statements: the caller wraps it.

drop function if exists public.platform_create_organization(text, text, text, timestamptz);
drop function if exists public.platform_update_subscription(uuid, text, jsonb);
drop function if exists public.platform_organizations();
drop function if exists public.platform_members(uuid);
