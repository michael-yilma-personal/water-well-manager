-- Rollback of 20261123000000_saas_members.sql.
--
-- Run AFTER the rollback of 20261123010000_drill_members.sql and BEFORE the
-- tenancy rollbacks. Drops the member-management functions and nothing else:
-- the memberships and audit rows they wrote stay. No transaction statements:
-- the caller wraps it.

drop function if exists public.accept_membership(uuid);
drop function if exists public.decline_membership(uuid);
drop function if exists public.saas_add_member(uuid, uuid, text, text, text, uuid);
drop function if exists public.saas_set_member_role(uuid, uuid, text, uuid);
drop function if exists public.saas_set_member_badge(uuid, uuid, text, uuid);
drop function if exists public.saas_set_member_status(uuid, uuid, text, uuid);
drop function if exists public.saas_remove_member(uuid, uuid, uuid);

-- Last: the functions above call these.
drop function if exists public.saas_member_changing(uuid, uuid, text, text, text, text);
drop function if exists public.saas_member_record_count(uuid, uuid);
drop function if exists public.saas_roles();
