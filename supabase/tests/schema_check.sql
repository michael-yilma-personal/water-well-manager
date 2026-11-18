-- Schema check (Phase 1 criterion 16, proposal section 10).
--
-- Defines a session-local view, schema_check_violations(table_name, problem),
-- with one row for every table in `public` that
--   * does not have row level security enabled, or
--   * has neither an org_id column nor an entry on the allowlist below.
-- No rows means the schema passes. supabase/tests/run.sh runs it against the
-- database built from the migrations and fails on any row; on its own:
--
--   psql -X -At -f supabase/tests/schema_check.sql \
--        -c 'select table_name, problem from schema_check_violations order by 1, 2'
--
-- The allowlist is for tables that are deliberately not organization-scoped.
-- Adding a name to it is a security decision and belongs in a review.

create temporary view schema_check_violations as
with allowlist (table_name) as (
  values ('profiles'), ('organizations'), ('memberships'), ('platform_admins'), ('audit_log')
),
tables as (
  select c.oid, c.relname::text as table_name, c.relrowsecurity
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind in ('r', 'p')
)
select t.table_name, 'row level security is not enabled'::text as problem
from tables t
where not t.relrowsecurity
union all
select t.table_name, 'no org_id column and not on the allowlist'
from tables t
where t.table_name not in (select table_name from allowlist)
  and not exists (
    select 1 from pg_attribute a
    where a.attrelid = t.oid and a.attname = 'org_id' and a.attnum > 0 and not a.attisdropped);
