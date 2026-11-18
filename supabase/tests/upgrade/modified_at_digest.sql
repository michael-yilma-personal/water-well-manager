-- Criterion 21: the backfill must not move modified_at, or every device would
-- download everything again. One line per record table: row count and a hash
-- of (id, modified_at). Taken by supabase/tests/local.sh before and after the
-- tenancy migrations. Read-only.
\pset format unaligned
\pset tuples_only on

select 'boreholes|' || count(*) || '|' || coalesce(md5(string_agg(id::text || '=' || modified_at::text, ',' order by id)), '') from public.boreholes
union all
select 'pipe_records|' || count(*) || '|' || coalesce(md5(string_agg(id::text || '=' || modified_at::text, ',' order by id)), '') from public.pipe_records
union all
select 'drilling_events|' || count(*) || '|' || coalesce(md5(string_agg(id::text || '=' || modified_at::text, ',' order by id)), '') from public.drilling_events
union all
select 'shift_logs|' || count(*) || '|' || coalesce(md5(string_agg(id::text || '=' || modified_at::text, ',' order by id)), '') from public.shift_logs;
