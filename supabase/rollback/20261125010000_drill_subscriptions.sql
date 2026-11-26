-- Rollback of 20261125010000_drill_subscriptions.sql.
--
-- Run FIRST, before the saas_subscriptions rollback (newest first). Drops the
-- triggers, policies and functions that migration added and nothing else: no
-- data is touched, and the policies of drill_tenancy are as they were. From
-- then on the subscription no longer decides anything for records or photos.
-- No transaction statements: the caller wraps it.

drop policy if exists drilling_photos_subscription_select on storage.objects;
drop policy if exists drilling_photos_subscription_insert on storage.objects;

do $do$
declare
  t text;
begin
  foreach t in array array['boreholes', 'pipe_records', 'drilling_events', 'shift_logs']
  loop
    execute format('drop policy if exists %I on public.%I', t || '_subscription', t);
    execute format('drop trigger if exists %I on public.%I', t || '_subscription_guard', t);
  end loop;
end
$do$;

drop function if exists public.drilling_photo_access(text);
drop function if exists public.subscription_write_guard();
