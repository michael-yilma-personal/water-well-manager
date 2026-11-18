-- Data as it exists before tenancy: accounts, profiles with roles and badges,
-- one banned account, one whose ban has expired, records by several authors
-- (one soft-deleted), a photo under the legacy path. Loaded by
-- supabase/tests/local.sh into a scratch database that has only the
-- pre-tenancy migrations; the tenancy migrations are applied on top of it.
-- Ids follow lib/helpers.sql (t.uid / t.rid) so the checks can name them.

create function pg_temp.uid(label text) returns uuid
language sql immutable
as $$ select md5('drill-db-test:' || label)::uuid $$;

insert into auth.users (id, email, raw_user_meta_data, banned_until) values
  (pg_temp.uid('l_driller'), 'l_driller@db-test.invalid', '{"name": "Legacy Driller", "badge_number": "D-1"}', null),
  (pg_temp.uid('l_logger'),  'l_logger@db-test.invalid',  '{"name": "Legacy Logger"}',                        null),
  (pg_temp.uid('l_super'),   'l_super@db-test.invalid',   '{"name": "Legacy Supervisor", "badge_number": "S-1"}', null),
  (pg_temp.uid('l_admin'),   'l_admin@db-test.invalid',   '{"name": "Legacy Admin"}',                         null),
  -- The admin-users function bans with ban_duration '876000h'.
  (pg_temp.uid('l_banned'),  'l_banned@db-test.invalid',  '{"name": "Legacy Banned", "badge_number": "D-9"}', now() + interval '876000 hours'),
  -- A ban that ran out is not a ban: the function reports "deactivated" only while banned_until is in the future.
  (pg_temp.uid('l_expired'), 'l_expired@db-test.invalid', '{"name": "Legacy Expired"}',                       now() - interval '1 day');

update public.profiles set role = 'Data Logger'   where id = pg_temp.uid('l_logger');
update public.profiles set role = 'Supervisor'    where id in (pg_temp.uid('l_super'), pg_temp.uid('l_expired'));
update public.profiles set role = 'Administrator' where id = pg_temp.uid('l_admin');

insert into public.boreholes (id, name, created_by, recorded_at, deleted_at) values
  (pg_temp.uid('boreholes:l_driller'), 'BH-1', pg_temp.uid('l_driller'), now() - interval '30 days', null),
  (pg_temp.uid('boreholes:l_banned'),  'BH-2', pg_temp.uid('l_banned'),  now() - interval '20 days', null),
  (pg_temp.uid('boreholes:l_super'),   'BH-3', pg_temp.uid('l_super'),   now() - interval '10 days', now() - interval '9 days');

insert into public.pipe_records (id, borehole_id, pipe_number, start_depth, end_depth, formation, created_by, recorded_at) values
  (pg_temp.uid('pipe_records:l_driller'),  pg_temp.uid('boreholes:l_driller'), 1, 0, 6,  'Clay',   pg_temp.uid('l_driller'), now() - interval '30 days'),
  (pg_temp.uid('pipe_records:l_driller2'), pg_temp.uid('boreholes:l_driller'), 2, 6, 12, 'Gravel', pg_temp.uid('l_driller'), now() - interval '29 days'),
  (pg_temp.uid('pipe_records:l_banned'),   pg_temp.uid('boreholes:l_banned'),  1, 0, 6,  'Sand',   pg_temp.uid('l_banned'),  now() - interval '20 days');

insert into public.drilling_events (id, borehole_id, type, created_by, recorded_at) values
  (pg_temp.uid('drilling_events:l_driller'), pg_temp.uid('boreholes:l_driller'), 'Bit Change', pg_temp.uid('l_driller'), now() - interval '29 days');

insert into public.shift_logs (id, borehole_id, notes, created_by, recorded_at) values
  (pg_temp.uid('shift_logs:l_driller'), pg_temp.uid('boreholes:l_driller'), 'day 1', pg_temp.uid('l_driller'), now() - interval '30 days'),
  (pg_temp.uid('shift_logs:l_super'),   pg_temp.uid('boreholes:l_super'),   'day 1', pg_temp.uid('l_super'),   now() - interval '10 days');

insert into storage.objects (bucket_id, name, owner) values
  ('drilling-photos', pg_temp.uid('l_driller') || '/old.jpg', pg_temp.uid('l_driller'));
