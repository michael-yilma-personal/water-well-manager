-- The rollback rehearsals (85, 90, 95) take the database back to Phase 1 or
-- Phase 2 inside their transaction. Whatever a LATER migration added has to
-- go first, as it would in a real rollback (newest first): subscriptions
-- reference organizations, so the foundation's tables cannot be dropped
-- underneath them. Skipped where that migration is not applied.
select to_regclass('public.subscriptions') is not null as has_subscriptions \gset
\if :has_subscriptions
\i :rollback_saas_subscriptions
\endif
