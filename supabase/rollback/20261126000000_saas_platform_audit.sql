-- Rollback of 20261126000000_saas_platform_audit.sql.
--
-- Run FIRST (newest first), before the saas_platform rollback. Drops the
-- audit history function and nothing else. No transaction statements: the
-- caller wraps it.

drop function if exists public.platform_audit(uuid, integer);
