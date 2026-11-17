-- Criterion 16: the schema check itself, tried against deliberately bad
-- scratch tables, then against the real schema.
-- plan: 9
begin;
\ir ../lib/helpers.sql
\ir ../schema_check.sql

create function t.flagged(tbl text) returns text
language sql stable
as $$
  select coalesce(string_agg(problem, ' + ' order by problem), 'clean')
  from schema_check_violations where table_name = tbl
$$;

create table public.zz_t_no_rls_no_org (id int);
create table public.zz_t_rls_no_org (id int);
alter table public.zz_t_rls_no_org enable row level security;
create table public.zz_t_org_no_rls (id int, org_id uuid);
create table public.zz_t_good (id int, org_id uuid);
alter table public.zz_t_good enable row level security;
create table public.zz_t_dropped_org (id int, org_id uuid);
alter table public.zz_t_dropped_org enable row level security;
alter table public.zz_t_dropped_org drop column org_id;
create table public.zz_t_partitioned (id int, d date) partition by range (d);
create table public."Profiles" (id int);
alter table public."Profiles" enable row level security;

select t.ok('[c16] a table with no RLS and no org_id is reported for both',
  $$ select t.flagged('zz_t_no_rls_no_org') = 'no org_id column and not on the allowlist + row level security is not enabled' $$);
select t.ok('[c16] a table with RLS but no org_id is reported',
  $$ select t.flagged('zz_t_rls_no_org') = 'no org_id column and not on the allowlist' $$);
select t.ok('[c16] a table with org_id but no RLS is reported',
  $$ select t.flagged('zz_t_org_no_rls') = 'row level security is not enabled' $$);
select t.ok('[c16] a table with RLS and org_id is not reported',
  $$ select t.flagged('zz_t_good') = 'clean' $$);
select t.ok('[c16] a table whose org_id column was dropped is reported',
  $$ select t.flagged('zz_t_dropped_org') = 'no org_id column and not on the allowlist' $$);
select t.ok('[c16] a partitioned table is checked like any other',
  $$ select t.flagged('zz_t_partitioned') = 'no org_id column and not on the allowlist + row level security is not enabled' $$);
select t.ok('[c16] the allowlist matches names exactly ("Profiles" is not profiles)',
  $$ select t.flagged('Profiles') = 'no org_id column and not on the allowlist' $$);

alter table public.profiles disable row level security;
select t.ok('[c16] the allowlist excuses a missing org_id, never missing RLS',
  $$ select t.flagged('profiles') = 'row level security is not enabled' $$);
alter table public.profiles enable row level security;

select t.ok('[c16] the schema built from the migrations passes: ' ||
            coalesce((select string_agg(table_name || ' (' || problem || ')', ', ' order by table_name, problem)
                      from schema_check_violations where table_name not like 'zz_t_%' and table_name <> 'Profiles'),
                     'no violation'),
  $$ select count(*) = 0 from schema_check_violations where table_name not like 'zz_t_%' and table_name <> 'Profiles' $$);

rollback;
select 'done';
