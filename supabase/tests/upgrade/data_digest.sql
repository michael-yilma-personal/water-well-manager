-- A digest of the data that existed before the tenancy migrations: one line
-- per table with its row count and a hash of its rows. org_id is left out so
-- the same digest can be taken before the migration, after it and after the
-- rollback; modified_at is left out because the requirement does not say
-- whether a backfill may move it. Read-only. Used by supabase/tests/local.sh.
\pset format unaligned
\pset tuples_only on

select 'profiles|' || count(*) || '|' || coalesce(md5(string_agg(to_jsonb(r)::text, '' order by r.id)), '') from public.profiles r
union all
select 'boreholes|' || count(*) || '|' || coalesce(md5(string_agg((to_jsonb(r) - 'org_id' - 'modified_at')::text, '' order by r.id)), '') from public.boreholes r
union all
select 'pipe_records|' || count(*) || '|' || coalesce(md5(string_agg((to_jsonb(r) - 'org_id' - 'modified_at')::text, '' order by r.id)), '') from public.pipe_records r
union all
select 'drilling_events|' || count(*) || '|' || coalesce(md5(string_agg((to_jsonb(r) - 'org_id' - 'modified_at')::text, '' order by r.id)), '') from public.drilling_events r
union all
select 'shift_logs|' || count(*) || '|' || coalesce(md5(string_agg((to_jsonb(r) - 'org_id' - 'modified_at')::text, '' order by r.id)), '') from public.shift_logs r
union all
select 'photos|' || count(*) || '|' || coalesce(md5(string_agg(bucket_id || ':' || name || ':' || coalesce(owner::text, ''), '' order by bucket_id, name)), '') from storage.objects
union all
select 'accounts|' || count(*) || '|' || coalesce(md5(string_agg(id::text || ':' || coalesce(banned_until::text, ''), '' order by id)), '') from auth.users;
