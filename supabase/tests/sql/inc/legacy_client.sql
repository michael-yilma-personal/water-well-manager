-- What the released build (1.1.7) and the current dashboard do today, at the
-- database: accounts made the way the admin-users function makes them, and
-- writes that never mention org_id. Requires lib/helpers.sql and a database
-- with at most one organization.
--
-- These checks pass on the six pre-tenancy migrations and must keep passing
-- after the tenancy migrations (criteria 9, 10, 11 and the Phase 1 acceptance
-- "works unchanged against the migrated database"), and again after a
-- rollback (criterion 14). Included by 05_legacy_client.sql and by
-- 90_rollback_in_transaction.sql; the caller owns the transaction.

insert into t.blockers values ('the legacy accounts');

do $fx$
declare
  u record;
begin
  for u in
    select * from (values
      ('lc_driller',  'Driller'),
      ('lc_driller2', 'Driller'),
      ('lc_logger',   'Data Logger'),
      ('lc_super',    'Supervisor'),
      ('lc_admin',    'Administrator'),
      ('lc_unused',   'Driller')) v(actor, role)
  loop
    -- auth.admin.createUser, then the function's profile update.
    insert into auth.users (id, email, raw_user_meta_data)
      values (t.uid(u.actor), u.actor || '@db-test.invalid', jsonb_build_object('name', u.actor));
    update public.profiles set name = u.actor, role = u.role, badge_number = 'B-' || u.actor
      where id = t.uid(u.actor);
  end loop;
end
$fx$;

delete from t.blockers
where what = 'the legacy accounts'
  and (select count(*) from public.profiles
       where id in (t.uid('lc_driller'), t.uid('lc_driller2'), t.uid('lc_logger'), t.uid('lc_super'), t.uid('lc_admin'), t.uid('lc_unused'))
         and name like 'lc\_%' and badge_number like 'B-lc\_%') = 6
  and (select role from public.profiles where id = t.uid('lc_admin')) = 'Administrator'
  and (select role from public.profiles where id = t.uid('lc_super')) = 'Supervisor'
  and (select role from public.profiles where id = t.uid('lc_logger')) = 'Data Logger';

-- The driller logs a hole and its records, as the field app would.
select t.did('[legacy] a driller creates a borehole without sending org_id', 'lc_driller',
  t.ins('boreholes', t.rid('boreholes', 'lc'), null, t.uid('lc_driller')), 1);
select t.did(format('[legacy] a driller adds a row to %s without sending org_id', tbl), 'lc_driller',
  t.ins(tbl, t.rid(tbl, 'lc'), t.rid('boreholes', 'lc'), t.uid('lc_driller')), 1)
from t.tables where is_child order by tbl;

select t.rows(format('[legacy] a driller reads their own row of %s', tbl), 'lc_driller',
  format('select id from public.%I where id = %L', tbl, t.rid(tbl, 'lc')), 1)
from t.tables order by tbl;
select t.rows(format('[legacy] a driller changes their own row of %s', tbl), 'lc_driller',
  format('update public.%I set %I = ''changed'' where id = %L', tbl, col, t.rid(tbl, 'lc')), 1)
from t.tables order by tbl;
select t.rows(format('[legacy] a driller soft-deletes their own row of %s', tbl), 'lc_driller',
  format('update public.%I set deleted_at = now() where id = %L', tbl, t.rid(tbl, 'lc')), 1)
from t.tables order by tbl;
select t.rows(format('[legacy] a driller re-sends their own row of %s as an upsert', tbl), 'lc_driller',
  t.ins(tbl, t.rid(tbl, 'lc'), t.rid('boreholes', 'lc'), t.uid('lc_driller'))
    || format(' on conflict (id) do update set %I = ''resent''', col), 1)
from t.tables order by tbl;
select t.throws(format('[legacy] nobody hard-deletes: a driller''s DELETE on their own row of %s is refused', tbl), 'lc_driller',
  format('delete from public.%I where id = %L', tbl, t.rid(tbl, 'lc')), '42501')
from t.tables order by tbl;

-- Another driller.
select t.none(format('[legacy] another driller cannot read the row of %s', tbl), 'lc_driller2',
  format('select id from public.%I where id = %L', tbl, t.rid(tbl, 'lc')))
from t.tables order by tbl;
select t.none(format('[legacy] another driller cannot change the row of %s', tbl), 'lc_driller2',
  format('update public.%I set %I = ''hijacked'' where id = %L', tbl, col, t.rid(tbl, 'lc')))
from t.tables order by tbl;
select t.throws(format('[legacy] another driller''s upsert onto the row of %s is rejected', tbl), 'lc_driller2',
  t.ins(tbl, t.rid(tbl, 'lc'), t.rid('boreholes', 'lc'), t.uid('lc_driller2'))
    || format(' on conflict (id) do update set %I = ''hijacked''', col), '42501')
from t.tables order by tbl;

-- Data Logger: a crew role like the driller.
select t.rows('[legacy] a data logger creates a borehole without sending org_id', 'lc_logger',
  t.ins('boreholes', t.rid('boreholes', 'lc_logger'), null, t.uid('lc_logger')), 1);

-- Supervisor.
select t.rows(format('[legacy] a supervisor reads the driller''s row of %s', tbl), 'lc_super',
  format('select id from public.%I where id = %L', tbl, t.rid(tbl, 'lc')), 1)
from t.tables order by tbl;
select t.rows('[legacy] a supervisor creates a borehole without sending org_id', 'lc_super',
  t.ins('boreholes', t.rid('boreholes', 'lc_super'), null, t.uid('lc_super')), 1);
select t.ok('[legacy] a supervisor corrects the formation of the driller''s pipe record and is stamped as editor', 'lc_super',
  format('with u as (update public.pipe_records set formation = ''Basalt'' where id = %L returning edited_by) select edited_by = %L from u',
         t.rid('pipe_records', 'lc'), t.uid('lc_super')));
select t.throws('[legacy] a supervisor cannot change the depth of the driller''s pipe record', 'lc_super',
  format('update public.pipe_records set end_depth = 99 where id = %L', t.rid('pipe_records', 'lc')), '42501');
select t.throws('[legacy] a supervisor cannot soft-delete the driller''s pipe record', 'lc_super',
  format('update public.pipe_records set deleted_at = now() where id = %L', t.rid('pipe_records', 'lc')), '42501');
select t.none(format('[legacy] a supervisor cannot change the driller''s row of %s', tbl), 'lc_super',
  format('update public.%I set %I = ''changed'' where id = %L', tbl, col, t.rid(tbl, 'lc')))
from t.tables where tbl <> 'pipe_records' order by tbl;

-- Administrator: reads everything, authors nothing.
select t.rows(format('[legacy] an administrator reads the driller''s row of %s', tbl), 'lc_admin',
  format('select id from public.%I where id = %L', tbl, t.rid(tbl, 'lc')), 1)
from t.tables order by tbl;
select t.throws(format('[legacy] an administrator cannot create a row of %s', tbl), 'lc_admin',
  t.ins(tbl, t.rid(tbl, 'lc_admin'), t.rid('boreholes', 'lc'), t.uid('lc_admin')), '42501')
from t.tables order by tbl;
select t.rows('[legacy] an administrator corrects the formation of the driller''s pipe record', 'lc_admin',
  format('update public.pipe_records set formation = ''Basalt'' where id = %L', t.rid('pipe_records', 'lc')), 1);
select t.throws('[legacy] an administrator cannot change the depth of the driller''s pipe record', 'lc_admin',
  format('update public.pipe_records set end_depth = 99 where id = %L', t.rid('pipe_records', 'lc')), '42501');
select t.none(format('[legacy] an administrator cannot change the driller''s row of %s', tbl), 'lc_admin',
  format('update public.%I set %I = ''changed'' where id = %L', tbl, col, t.rid(tbl, 'lc')))
from t.tables where tbl <> 'pipe_records' order by tbl;

-- Signed out.
select t.none(format('[legacy] a signed-out client reads nothing from %s', tbl), 'anon',
  format('select * from public.%I', tbl))
from (select tbl from t.tables union select 'profiles') x order by tbl;

-- Profiles.
select t.rows('[legacy] a user reads their own profile', 'lc_driller',
  format('select id from public.profiles where id = %L', t.uid('lc_driller')), 1);
select t.none('[legacy] a driller cannot read another user''s profile', 'lc_driller',
  format('select id from public.profiles where id = %L', t.uid('lc_super')));
select t.rows('[legacy] a supervisor reads a crew member''s profile', 'lc_super',
  format('select id from public.profiles where id = %L', t.uid('lc_driller')), 1);
select t.rows('[legacy] an administrator reads a crew member''s profile', 'lc_admin',
  format('select id from public.profiles where id = %L', t.uid('lc_driller')), 1);
select t.rows('[legacy] a user changes their own display name', 'lc_driller',
  format('update public.profiles set name = ''New name'' where id = %L', t.uid('lc_driller')), 1);
select t.throws('[legacy] a user cannot change their own role', 'lc_driller',
  format('update public.profiles set role = ''Administrator'' where id = %L', t.uid('lc_driller')), '42501');
select t.none('[legacy] an administrator cannot change another user''s profile directly', 'lc_admin',
  format('update public.profiles set name = ''x'' where id = %L', t.uid('lc_driller')));
select t.throws('[legacy] a user cannot delete a profile', 'lc_driller',
  format('delete from public.profiles where id = %L', t.uid('lc_driller')), '42501');

-- Photos under <user_id>/<file>, the only path an installed build knows.
select t.did('[legacy] a driller uploads a photo to their own folder', 'lc_driller',
  format('insert into storage.objects (bucket_id, name, owner) values (''drilling-photos'', %L, %L)',
         t.uid('lc_driller') || '/pipe.jpg', t.uid('lc_driller')), 1);
select t.rows('[legacy] a driller reads their own photo', 'lc_driller',
  format('select name from storage.objects where bucket_id = ''drilling-photos'' and name = %L', t.uid('lc_driller') || '/pipe.jpg'), 1);
select t.rows('[legacy] an administrator reads the driller''s photo', 'lc_admin',
  format('select name from storage.objects where bucket_id = ''drilling-photos'' and name = %L', t.uid('lc_driller') || '/pipe.jpg'), 1);
select t.none('[legacy] another driller cannot read the photo', 'lc_driller2',
  format('select name from storage.objects where bucket_id = ''drilling-photos'' and name = %L', t.uid('lc_driller') || '/pipe.jpg'));
select t.none('[legacy] a supervisor cannot read the photo (administrators only, as today)', 'lc_super',
  format('select name from storage.objects where bucket_id = ''drilling-photos'' and name = %L', t.uid('lc_driller') || '/pipe.jpg'));
select t.throws('[legacy] a driller cannot upload into another user''s folder', 'lc_driller2',
  format('insert into storage.objects (bucket_id, name, owner) values (''drilling-photos'', %L, %L)',
         t.uid('lc_driller') || '/planted.jpg', t.uid('lc_driller2')), '42501');
select t.none('[legacy] a signed-out client reads no photo', 'anon',
  $$ select name from storage.objects where bucket_id = 'drilling-photos' $$);

-- The admin-users function deletes accounts (auth.admin.deleteUser).
select t.rows('[legacy] an account that has logged nothing can be deleted', null,
  format('delete from auth.users where id = %L', t.uid('lc_unused')), 1);
