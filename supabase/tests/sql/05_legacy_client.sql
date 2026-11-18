-- The installed build's behaviour, before and after tenancy (criteria 9, 10,
-- 11; Phase 1 acceptance: "the released APK and current dashboard work
-- unchanged against the migrated database"). Runs on a database freshly built
-- from the migrations, where at most one organization exists.
-- plan: 82
begin;
\ir ../lib/helpers.sql
\ir inc/legacy_client.sql
rollback;
select 'done';
