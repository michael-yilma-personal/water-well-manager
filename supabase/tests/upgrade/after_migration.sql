-- Criteria 6 and 7 on a database that held data before the tenancy
-- migrations (upgrade/seed_legacy.sql). Run by supabase/tests/local.sh only:
-- CI's database starts empty, so it cannot show a backfill.
-- plan: 37
begin;
\ir ../lib/helpers.sql

create function t.m(actor text) returns text
language sql stable
as $$
  select coalesce(string_agg(format('%s/%s/%s', role, status, coalesce(badge_number, '-')), ' + ' order by org_id), 'no membership')
  from public.memberships where user_id = t.uid(actor)
$$;

insert into t.blockers values ('the legacy data');
delete from t.blockers
where what = 'the legacy data'
  and (select count(*) from public.profiles) = 6
  and (select count(*) from public.boreholes) = 3
  and (select count(*) from auth.users where banned_until > now()) = 1;

select t.ok('[c6] exactly one organization exists after the migration, named "Founding organization"',
  $$ select count(*) = 1 and min(name) = 'Founding organization' from public.organizations $$);
select t.ok('[c6] every existing profile has exactly one membership, all in the founding organization',
  $$ select count(*) = 6
        and count(distinct user_id) = 6
        and bool_and(org_id = (select id from public.organizations))
        and not exists (select 1 from public.profiles p where not exists (select 1 from public.memberships m where m.user_id = p.id))
     from public.memberships $$);
select t.ok('[c6] every membership carries its profile''s role and badge',
  $$ select not exists (select 1 from public.profiles p join public.memberships m on m.user_id = p.id
                        where m.role is distinct from p.role or m.badge_number is distinct from p.badge_number) $$);
select t.ok(format('[c6] the membership of %s is %s', actor, expected),
  format($$ select t.m(%L) = %L $$, actor, expected))
from (values
  ('l_driller', 'Driller/active/D-1'),
  ('l_logger',  'Data Logger/active/-'),
  ('l_super',   'Supervisor/active/S-1'),
  ('l_admin',   'Administrator/active/-'),
  ('l_banned',  'Driller/deactivated/D-9'),
  ('l_expired', 'Supervisor/active/-')      -- the ban ran out; the account can sign in
) v(actor, expected);

select t.ok(format('[c7] %s: all %s existing row(s) are kept and carry the founding organization', tbl, n),
  format($$ select count(*) = %s and count(*) filter (where org_id = (select id from public.organizations)) = %s from public.%I $$, n, n, tbl))
from (values ('boreholes', 3), ('pipe_records', 3), ('drilling_events', 1), ('shift_logs', 2)) v(tbl, n);
select t.ok(format('[c7] %s.org_id is not null', tbl),
  format($$ select attnotnull from pg_attribute where attrelid = 'public.%I'::regclass and attname = 'org_id' and not attisdropped $$, tbl))
from t.tables order by tbl;
select t.ok('[c7] a soft-deleted borehole is assigned too',
  format($$ select org_id = (select id from public.organizations) and deleted_at is not null from public.boreholes where id = %L $$, t.rid('boreholes', 'l_super')));

-- The people who were using the system keep what they had.
select t.rows('[upgrade] the driller reads their borehole', 'l_driller',
  format('select id from public.boreholes where id = %L', t.rid('boreholes', 'l_driller')), 1);
select t.rows('[upgrade] the driller reads their two pipe records', 'l_driller',
  'select id from public.pipe_records', 2);
select t.ok('[upgrade] the driller adds a pipe record without sending org_id, and it lands in the founding organization', 'l_driller',
  format('with i as (%s returning org_id) select org_id = (select id from public.organizations) from i',
         t.ins('pipe_records', t.uid('new'), t.rid('boreholes', 'l_driller'), t.uid('l_driller'))));
select t.ok('[upgrade] the driller starts a borehole without sending org_id, and it lands in the founding organization', 'l_driller',
  format('with i as (%s returning org_id) select org_id = (select id from public.organizations) from i',
         t.ins('boreholes', t.uid('new'), null, t.uid('l_driller'))));
select t.rows(format('[upgrade] %s reads all three boreholes, the banned author''s included', actor), actor,
  'select id from public.boreholes', 3)
from (values ('l_super'), ('l_admin'), ('l_expired')) v(actor);
select t.none('[upgrade] the data logger, who has logged nothing, reads no borehole', 'l_logger',
  'select id from public.boreholes');
select t.none(format('[c6] the banned account reads nothing from %s', tbl), 'l_banned',
  format('select id from public.%I', tbl))
from t.tables order by tbl;
select t.rows('[upgrade] the supervisor corrects the formation of the driller''s pipe record', 'l_super',
  format('update public.pipe_records set formation = ''Basalt'' where id = %L', t.rid('pipe_records', 'l_driller')), 1);
select t.rows('[c11] the driller reads their photo under the legacy path', 'l_driller',
  format('select name from storage.objects where bucket_id = ''drilling-photos'' and name = %L', t.uid('l_driller') || '/old.jpg'), 1);
select t.rows('[c11] the administrator reads the photo under the legacy path', 'l_admin',
  format('select name from storage.objects where bucket_id = ''drilling-photos'' and name = %L', t.uid('l_driller') || '/old.jpg'), 1);
select t.none('[c11] the supervisor does not', 'l_super',
  format('select name from storage.objects where bucket_id = ''drilling-photos'' and name = %L', t.uid('l_driller') || '/old.jpg'));

-- Decision 28, for a ban that was already in force when the migration ran:
-- the ban is what deactivated that membership, so lifting it brings the
-- membership back. Last in the file: the checks above need the ban in place.
update auth.users set banned_until = null where id = t.uid('l_banned');
select t.ok('[c28] an account banned before the migration is unbanned after it: its membership is active again',
  $$ select t.m('l_banned') = 'Driller/active/D-9' $$);
select t.rows('[c28] ... and it reads its borehole again', 'l_banned',
  format('select id from public.boreholes where id = %L', t.rid('boreholes', 'l_banned')), 1);
update auth.users set banned_until = null where id = t.uid('l_expired');
select t.ok('[c24] clearing a ban that had run out before the migration leaves that membership active',
  $$ select t.m('l_expired') = 'Supervisor/active/-' $$);

rollback;
select 'done';
