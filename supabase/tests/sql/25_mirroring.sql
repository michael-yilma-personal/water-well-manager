-- Criterion 9: profiles and bans are mirrored into the membership, so the
-- current app, the admin-users function and installed builds keep working.
-- Runs on a database freshly built from the migrations (one organization).
-- plan: 34
begin;
\ir ../lib/helpers.sql

create function t.m(actor text) returns text
language sql stable
as $$
  select coalesce(string_agg(format('%s/%s/%s', role, status, coalesce(badge_number, '-')), ' + ' order by org_id), 'no membership')
  from public.memberships where user_id = t.uid(actor)
$$;

select t.ok('[c9] precondition: exactly one organization exists',
  $$ select count(*) = 1 from public.organizations $$);

-- auth.admin.createUser: the signup trigger makes the profile.
insert into auth.users (id, email, raw_user_meta_data)
  values (t.uid('m1'), 'm1@db-test.invalid', '{"name": "M One", "badge_number": "B-1"}');

select t.ok('[c9] a new account gets one membership, in the only organization',
  $$ select count(*) = 1 and bool_and(org_id = (select id from public.organizations))
     from public.memberships where user_id = t.uid('m1') $$);
select t.ok('[c9] that membership carries the profile''s role and badge and is active',
  $$ select t.m('m1') = 'Driller/active/B-1' $$);

-- The admin-users function writes profiles with the service-role key.
select t.did('[c9] the service role sets profiles.role to Data Logger', 'service',
  format('update public.profiles set role = ''Data Logger'' where id = %L', t.uid('m1')), 1);
select t.ok('[c9] ... and the membership role becomes Data Logger',
  $$ select t.m('m1') = 'Data Logger/active/B-1' $$);
select t.did('[c9] the service role sets profiles.role to Supervisor', 'service',
  format('update public.profiles set role = ''Supervisor'' where id = %L', t.uid('m1')), 1);
select t.ok('[c9] ... and the membership role becomes Supervisor',
  $$ select t.m('m1') = 'Supervisor/active/B-1' $$);
select t.did('[c9] the service role sets profiles.role to Administrator', 'service',
  format('update public.profiles set role = ''Administrator'' where id = %L', t.uid('m1')), 1);
select t.ok('[c9] ... and the membership role becomes Administrator',
  $$ select t.m('m1') = 'Administrator/active/B-1' $$);
select t.did('[c9] the service role sets profiles.role to Driller', 'service',
  format('update public.profiles set role = ''Driller'' where id = %L', t.uid('m1')), 1);
select t.ok('[c9] ... and the membership role becomes Driller',
  $$ select t.m('m1') = 'Driller/active/B-1' $$);

select t.did('[c9] the service role changes profiles.badge_number', 'service',
  format('update public.profiles set badge_number = ''B-2'' where id = %L', t.uid('m1')), 1);
select t.ok('[c9] ... and the membership badge follows',
  $$ select t.m('m1') = 'Driller/active/B-2' $$);

select t.did('[c9] a user changes their own badge number (they hold no privilege on memberships)', 'm1',
  format('update public.profiles set badge_number = ''B-3'' where id = %L', t.uid('m1')), 1);
select t.ok('[c9] ... and the membership badge follows',
  $$ select t.m('m1') = 'Driller/active/B-3' $$);

select t.did('[c9] the badge is cleared on the profile', 'service',
  format('update public.profiles set badge_number = null where id = %L', t.uid('m1')), 1);
select t.ok('[c9] ... and cleared on the membership',
  $$ select t.m('m1') = 'Driller/active/-' $$);

select t.did('[c9] a change of display name alone goes through', 'm1',
  format('update public.profiles set name = ''Renamed'' where id = %L', t.uid('m1')), 1);
select t.ok('[c9] ... and leaves the membership as it was',
  $$ select t.m('m1') = 'Driller/active/-' $$);

-- Ban and unban (admin-users: ban_duration '876000h' / 'none').
select t.did('[c9] the user logs a borehole while active', 'm1',
  t.ins('boreholes', t.rid('boreholes', 'm1'), null, t.uid('m1')), 1);

update auth.users set banned_until = now() + interval '876000 hours' where id = t.uid('m1');
select t.ok('[c9] a ban deactivates the membership',
  $$ select t.m('m1') = 'Driller/deactivated/-' $$);
select t.none('[c9] ... and a token issued before the ban reads nothing', 'm1',
  $$ select id from public.boreholes $$);
select t.throws('[c9] ... and writes nothing', 'm1',
  t.ins('boreholes', t.uid('new'), null, t.uid('m1')), '42501');

select t.did('[c9] a role change while banned is mirrored', 'service',
  format('update public.profiles set role = ''Supervisor'' where id = %L', t.uid('m1')), 1);
select t.ok('[c9] ... without reactivating the membership',
  $$ select t.m('m1') = 'Supervisor/deactivated/-' $$);

update auth.users set banned_until = null where id = t.uid('m1');
select t.ok('[c9] an unban reactivates the membership',
  $$ select t.m('m1') = 'Supervisor/active/-' $$);
select t.rows('[c9] ... and the user reads their borehole again', 'm1',
  format('select id from public.boreholes where id = %L', t.rid('boreholes', 'm1')), 1);

-- Once a second organization exists, nobody is enrolled automatically.
insert into public.organizations (id, name) values (t.uid('org_second'), 'Second');
insert into auth.users (id, email) values (t.uid('m2'), 'm2@db-test.invalid');

select t.ok('[c9] with two organizations, a new account still gets its profile',
  $$ select count(*) = 1 from public.profiles where id = t.uid('m2') $$);
select t.ok('[c9] ... but no membership anywhere',
  $$ select t.m('m2') = 'no membership' $$);
select t.did('[c9] a profile change for an account with no membership goes through', 'service',
  format('update public.profiles set role = ''Administrator'', badge_number = ''X'' where id = %L', t.uid('m2')), 1);
select t.ok('[c9] ... and creates no membership',
  $$ select t.m('m2') = 'no membership' $$);
select t.none('[c9] ... so a legacy profiles.role of Administrator with no membership reads nothing', 'm2',
  $$ select id from public.boreholes $$);

select t.did('[c9] with two organizations, an existing member''s profile change goes through', 'service',
  format('update public.profiles set role = ''Data Logger'', badge_number = ''B-9'' where id = %L', t.uid('m1')), 1);
select t.ok('[c9] ... and is still mirrored into their one membership',
  $$ select t.m('m1') = 'Data Logger/active/B-9' $$);

rollback;
select 'done';
