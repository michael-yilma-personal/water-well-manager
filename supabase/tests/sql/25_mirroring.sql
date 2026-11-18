-- Criterion 9, with decisions 26-28: profiles and bans are mirrored into the
-- membership in the FOUNDING organization, and only there; only what changed
-- is copied; an unban brings back only what a ban took away.
--
-- The founding organization is the one that exists when this file starts: on
-- a database freshly built from the migrations there is exactly one. Nothing
-- else is assumed about how the migration recognises it, so the file renames
-- it (the owner will, at production time) and creates the second organization
-- with an earlier created_at: neither its name nor its age may be what
-- identifies it.
-- plan: 66
begin;
\ir ../lib/helpers.sql

create table t.founding as select id from public.organizations;
grant select on t.founding to public;

create function t.f() returns uuid
language sql stable
as $$ select id from t.founding $$;

-- Every membership of the account.
create function t.m(actor text) returns text
language sql stable
as $$
  select coalesce(string_agg(format('%s/%s/%s', role, status, coalesce(badge_number, '-')), ' + ' order by org_id), 'no membership')
  from public.memberships where user_id = t.uid(actor)
$$;

-- The account's membership in one organization.
create function t.mo(actor text, org uuid) returns text
language sql stable
as $$
  select coalesce((select format('%s/%s/%s', role, status, coalesce(badge_number, '-'))
                   from public.memberships where user_id = t.uid(actor) and org_id = org), 'no membership')
$$;

select t.ok('[c9] precondition: exactly one organization exists',
  $$ select count(*) = 1 from public.organizations $$);

-- ---------------------------------------------------------------------------
-- One organization: what the current app and the admin-users function do
-- ---------------------------------------------------------------------------

-- auth.admin.createUser: the signup trigger makes the profile.
insert into auth.users (id, email, raw_user_meta_data)
  values (t.uid('m1'), 'm1@db-test.invalid', '{"name": "M One", "badge_number": "B-1"}');

select t.ok('[c9] a new account gets one membership, in the only organization',
  $$ select count(*) = 1 and bool_and(org_id = t.f())
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
select t.ok('[c9][c28] an unban reactivates the membership the ban deactivated',
  $$ select t.m('m1') = 'Supervisor/active/-' $$);
select t.rows('[c9] ... and the user reads their borehole again', 'm1',
  format('select id from public.boreholes where id = %L', t.rid('boreholes', 'm1')), 1);

-- ---------------------------------------------------------------------------
-- Decision 26: the mirror copies only what changed
-- ---------------------------------------------------------------------------
-- m3's membership and profile disagree, as they will once memberships are
-- managed per organization: the membership says Driller with badge M-1, the
-- legacy profile says Administrator with badge P-1.

insert into auth.users (id, email, raw_user_meta_data)
  values (t.uid('m3'), 'm3@db-test.invalid', '{"name": "M Three", "badge_number": "P-1"}');
update public.profiles set role = 'Administrator' where id = t.uid('m3');
update public.memberships set role = 'Driller', badge_number = 'M-1' where user_id = t.uid('m3');

select t.ok('[c26] setup: the membership says Driller, the legacy profile says Administrator',
  $$ select t.m('m3') = 'Driller/active/M-1'
        and (select role = 'Administrator' and badge_number = 'P-1' from public.profiles where id = t.uid('m3')) $$);

select t.did('[c26] that account edits its own badge number, as any signed-in user may', 'm3',
  format('update public.profiles set badge_number = ''P-2'' where id = %L', t.uid('m3')), 1);
select t.ok('[c26] ... the badge is mirrored and the membership role is NOT touched: still Driller',
  $$ select t.m('m3') = 'Driller/active/P-2' $$);
select t.none('[c26] ... so it still reads nobody else''s records', 'm3',
  format('select id from public.boreholes where id = %L', t.rid('boreholes', 'm1')));
select t.none('[c26] ... and is not an organization administrator', 'm3',
  $$ select 1 where public.is_org_admin(t.f()) or public.has_org_role(t.f(), 'Supervisor', 'Administrator') $$);
select t.none('[c26] ... and reads nobody else''s profile', 'm3',
  format('select id from public.profiles where id = %L', t.uid('m1')));

select t.did('[c26] the same account edits its display name', 'm3',
  format('update public.profiles set name = ''Renamed'' where id = %L', t.uid('m3')), 1);
select t.ok('[c26] ... and nothing in the membership moves',
  $$ select t.m('m3') = 'Driller/active/P-2' $$);

select t.did('[c26] an update that re-sends the same role, badge and a new name (what admin-users writes)', 'service',
  format('update public.profiles set role = ''Administrator'', badge_number = ''P-2'', name = ''Again'' where id = %L', t.uid('m3')), 1);
select t.ok('[c26] ... changes neither role nor badge, so nothing in the membership moves',
  $$ select t.m('m3') = 'Driller/active/P-2' $$);

update public.memberships set badge_number = 'M-9' where user_id = t.uid('m3');
select t.did('[c26] a change of profiles.role alone', 'service',
  format('update public.profiles set role = ''Supervisor'' where id = %L', t.uid('m3')), 1);
select t.ok('[c26] ... is mirrored, and the membership badge is NOT touched',
  $$ select t.m('m3') = 'Supervisor/active/M-9' $$);

-- ---------------------------------------------------------------------------
-- Decision 28: an unban reactivates only what a ban deactivated
-- ---------------------------------------------------------------------------

insert into auth.users (id, email) values (t.uid('m4'), 'm4@db-test.invalid');
update public.memberships set status = 'deactivated' where user_id = t.uid('m4');   -- by an administrator, not by a ban

select t.ok('[c28] setup: a membership deactivated directly, on an account that is not banned',
  $$ select t.m('m4') = 'Driller/deactivated/-' $$);
update auth.users set banned_until = now() + interval '876000 hours' where id = t.uid('m4');
select t.ok('[c28] a ban leaves it deactivated',
  $$ select t.m('m4') = 'Driller/deactivated/-' $$);
update auth.users set banned_until = null where id = t.uid('m4');
select t.ok('[c28] the unban does NOT reactivate it: the ban is not what deactivated it',
  $$ select t.m('m4') = 'Driller/deactivated/-' $$);
select t.none('[c28] ... and the account still reads nothing', 'm4',
  $$ select id from public.boreholes $$);

-- ---------------------------------------------------------------------------
-- Decision 27: with a second organization, mirroring stays in the founding one
-- ---------------------------------------------------------------------------

update public.organizations set name = 'Renamed by the owner' where id = t.f();
insert into public.organizations (id, name, created_at)
  values (t.uid('org_second'), 'Second', timestamptz '2000-01-01 00:00:00+00');

-- What admin-users POST produces: a new account, then a profile update.
insert into auth.users (id, email) values (t.uid('m2'), 'm2@db-test.invalid');

select t.ok('[c27] with two organizations, a new account still gets its profile',
  $$ select count(*) = 1 from public.profiles where id = t.uid('m2') $$);
select t.ok('[c27] ... and is enrolled in the founding organization, as before, and nowhere else',
  $$ select t.mo('m2', t.f()) = 'Driller/active/-'
        and (select count(*) from public.memberships where user_id = t.uid('m2')) = 1 $$);
select t.did('[c27] the profile update that follows goes through', 'service',
  format('update public.profiles set role = ''Supervisor'', badge_number = ''X'' where id = %L', t.uid('m2')), 1);
select t.ok('[c27] ... and is mirrored into the founding membership',
  $$ select t.m('m2') = 'Supervisor/active/X' and t.mo('m2', t.f()) = 'Supervisor/active/X' $$);
select t.rows('[c27] ... so the new Supervisor reads the founding organization''s records', 'm2',
  format('select id from public.boreholes where id = %L', t.rid('boreholes', 'm1')), 1);

select t.did('[c27] with two organizations, an existing founding member''s profile change goes through', 'service',
  format('update public.profiles set role = ''Data Logger'', badge_number = ''B-9'' where id = %L', t.uid('m1')), 1);
select t.ok('[c27] ... and is still mirrored into their founding membership',
  $$ select t.m('m1') = 'Data Logger/active/B-9' and t.mo('m1', t.f()) = 'Data Logger/active/B-9' $$);

-- x1 belongs to the second organization only. Whatever it was given on
-- creation is replaced by exactly that.
insert into auth.users (id, email) values (t.uid('x1'), 'x1@db-test.invalid');
delete from public.memberships where user_id = t.uid('x1');
insert into public.memberships (org_id, user_id, role, badge_number) values (t.uid('org_second'), t.uid('x1'), 'Driller', 'S-1');

select t.ok('[c27] setup: an account whose only membership is in another organization',
  $$ select t.m('x1') = 'Driller/active/S-1' and t.mo('x1', t.uid('org_second')) = 'Driller/active/S-1' $$);
select t.did('[c27] the service role sets that account''s profiles.role and badge', 'service',
  format('update public.profiles set role = ''Administrator'', badge_number = ''Q'' where id = %L', t.uid('x1')), 1);
select t.ok('[c27] ... and its membership in the other organization is NOT changed, nor one created in the founding organization',
  $$ select t.m('x1') = 'Driller/active/S-1' $$);
select t.none('[c27] ... so the other organization has not gained an Administrator', 'x1',
  $$ select 1 where public.is_org_admin(t.uid('org_second')) $$);
select t.did('[c27] that account edits its own badge number', 'x1',
  format('update public.profiles set badge_number = ''Q-2'' where id = %L', t.uid('x1')), 1);
select t.ok('[c27] ... and its membership in the other organization is NOT changed',
  $$ select t.m('x1') = 'Driller/active/S-1' $$);

update auth.users set banned_until = now() + interval '876000 hours' where id = t.uid('x1');
select t.ok('[c27] a ban of that account does NOT change its membership in the other organization',
  $$ select t.m('x1') = 'Driller/active/S-1' $$);
update public.memberships set status = 'deactivated' where user_id = t.uid('x1');   -- by that organization's administrator
update auth.users set banned_until = null where id = t.uid('x1');
select t.ok('[c27][c28] an unban does NOT reactivate a membership in another organization',
  $$ select t.m('x1') = 'Driller/deactivated/S-1' $$);

-- x2 belongs to both: Driller in the founding organization, Supervisor in the second.
insert into auth.users (id, email) values (t.uid('x2'), 'x2@db-test.invalid');
delete from public.memberships where user_id = t.uid('x2');
insert into public.memberships (org_id, user_id, role, badge_number) values
  (t.f(),               t.uid('x2'), 'Driller',    'F-0'),
  (t.uid('org_second'), t.uid('x2'), 'Supervisor', 'S-2');

select t.ok('[c27] setup: an account in the founding organization and in another',
  $$ select t.mo('x2', t.f()) = 'Driller/active/F-0' and t.mo('x2', t.uid('org_second')) = 'Supervisor/active/S-2' $$);
select t.did('[c27] the service role sets that account''s profiles.role and badge', 'service',
  format('update public.profiles set role = ''Data Logger'', badge_number = ''F-1'' where id = %L', t.uid('x2')), 1);
select t.ok('[c27] ... the founding membership is mirrored',
  $$ select t.mo('x2', t.f()) = 'Data Logger/active/F-1' $$);
select t.ok('[c27] ... and the membership in the other organization is NOT touched',
  $$ select t.mo('x2', t.uid('org_second')) = 'Supervisor/active/S-2' $$);

update auth.users set banned_until = now() + interval '876000 hours' where id = t.uid('x2');
select t.ok('[c27] a ban deactivates the founding membership',
  $$ select t.mo('x2', t.f()) = 'Data Logger/deactivated/F-1' $$);
select t.ok('[c27] ... and does NOT touch the membership in the other organization',
  $$ select t.mo('x2', t.uid('org_second')) = 'Supervisor/active/S-2' $$);
update auth.users set banned_until = null where id = t.uid('x2');
select t.ok('[c27] the unban reactivates the founding membership',
  $$ select t.mo('x2', t.f()) = 'Data Logger/active/F-1' $$);
select t.ok('[c27] ... and still does NOT touch the membership in the other organization',
  $$ select t.mo('x2', t.uid('org_second')) = 'Supervisor/active/S-2' $$);

rollback;
select 'done';
