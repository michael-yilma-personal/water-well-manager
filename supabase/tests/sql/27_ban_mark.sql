-- Decision 40 (RF-086): the mark "a ban deactivated this membership" cannot
-- outlive that deactivation, and cannot sit on a membership that is not
-- deactivated. Added in the validation of f1aabbe: with the first branch of
-- the guard on memberships removed, or the guard limited to updates, nothing
-- else in the suite failed.
--
-- Some checks write memberships.deactivated_by_ban directly, as the service
-- role could: a stale mark cannot be reached otherwise. They say so in their
-- names. What is asserted is always what the mark is FOR: whether a ban and
-- its lifting take a membership away and bring it back.
-- plan: 23
begin;
\ir ../lib/helpers.sql

create function t.m(actor text) returns text
language sql stable
as $$
  select coalesce(string_agg(format('%s/%s/%s', role, status, coalesce(badge_number, '-')), ' + ' order by org_id), 'no membership')
  from public.memberships where user_id = t.uid(actor)
$$;

create function t.ban(actor text) returns void
language sql
as $$ update auth.users set banned_until = now() + interval '876000 hours' where id = t.uid(actor) $$;

create function t.unban(actor text) returns void
language sql
as $$ update auth.users set banned_until = null where id = t.uid(actor) $$;

select t.ok('[c40] precondition: exactly one organization exists',
  $$ select count(*) = 1 from public.organizations $$);

insert into auth.users (id, email)
  select t.uid(a), a || '@db-test.invalid'
  from unnest(array['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8']) a;

-- k1: a membership written as ACTIVE with the mark already on it (a row put
-- there by hand, or by a later function with a slip in it).
delete from public.memberships where user_id = t.uid('k1');
select t.did('[c40] setup (names deactivated_by_ban): a membership is inserted active, with the ban mark set', 'service',
  format('insert into public.memberships (org_id, user_id, role, status, deactivated_by_ban) select id, %L, ''Driller'', ''active'', true from public.organizations',
         t.uid('k1')), 1);
select t.ok('[c40] (names deactivated_by_ban) ... the mark does not stay on a membership that is not deactivated',
  $$ select not deactivated_by_ban from public.memberships where user_id = t.uid('k1') $$);
select t.ban('k1');
select t.ok('[c40] ... a ban deactivates it',
  $$ select t.m('k1') = 'Driller/deactivated/-' $$);
select t.unban('k1');
select t.ok('[c40][c28] ... and lifting that ban brings it back: the stale mark did not make the ban look like a direct deactivation',
  $$ select t.m('k1') = 'Driller/active/-' $$);

-- k2: the same by an update that leaves the status alone.
select t.did('[c40] setup (names deactivated_by_ban): the mark is set on an active membership by an update', 'service',
  format('update public.memberships set deactivated_by_ban = true where user_id = %L', t.uid('k2')), 1);
select t.ok('[c40] (names deactivated_by_ban) ... and does not stay there either',
  $$ select not deactivated_by_ban from public.memberships where user_id = t.uid('k2') $$);
select t.ban('k2');
select t.unban('k2');
select t.ok('[c40][c28] ... a ban and its lifting leave that membership active',
  $$ select t.m('k2') = 'Driller/active/-' $$);

-- k3: invited, written with the mark. Accepted later (active); then a ban and
-- its lifting must work as for anyone.
select t.did('[c40] setup (names deactivated_by_ban): an invited membership is written with the mark', 'service',
  format('update public.memberships set status = ''invited'', deactivated_by_ban = true where user_id = %L', t.uid('k3')), 1);
select t.unban('k3');
select t.ok('[c40][c44] ... lifting a ban does not turn that invitation into an active membership',
  $$ select t.m('k3') = 'Driller/invited/-' $$);
update public.memberships set status = 'active' where user_id = t.uid('k3');
select t.ban('k3');
select t.unban('k3');
select t.ok('[c40][c28] ... and once accepted, a ban and its lifting leave it active',
  $$ select t.m('k3') = 'Driller/active/-' $$);

-- k4: deactivated by a ban, then set back to invited directly. The unban must
-- leave it invited (decision 40: any direct change of status clears the mark).
select t.ban('k4');
select t.did('[c40] setup: a membership the ban deactivated is set to invited directly', 'service',
  format('update public.memberships set status = ''invited'' where user_id = %L', t.uid('k4')), 1);
select t.unban('k4');
select t.ok('[c40] ... the unban leaves it invited',
  $$ select t.m('k4') = 'Driller/invited/-' $$);

-- k5: deactivated by a ban, reactivated directly while banned. The unban
-- leaves it as it is, and so does the next ban and unban round.
select t.ban('k5');
select t.did('[c40] setup: a membership the ban deactivated is reactivated directly, the ban still in force', 'service',
  format('update public.memberships set status = ''active'' where user_id = %L', t.uid('k5')), 1);
select t.unban('k5');
select t.ok('[c40] ... the unban leaves it active',
  $$ select t.m('k5') = 'Driller/active/-' $$);
select t.ban('k5');
select t.ok('[c40] ... a second ban deactivates it again',
  $$ select t.m('k5') = 'Driller/deactivated/-' $$);
select t.unban('k5');
select t.ok('[c40][c28] ... and its lifting brings it back',
  $$ select t.m('k5') = 'Driller/active/-' $$);

-- k6: what the dashboard does to a banned account must not cost it the mark:
-- a role and a badge change are not changes of status.
select t.ban('k6');
select t.did('[c40] setup: a banned member is re-roled and given a badge through the profile', 'service',
  format('update public.profiles set role = ''Supervisor'', badge_number = ''K-6'' where id = %L', t.uid('k6')), 1);
select t.ok('[c40] ... which reaches the membership and leaves it deactivated',
  $$ select t.m('k6') = 'Supervisor/deactivated/K-6' $$);
select t.unban('k6');
select t.ok('[c40][c28] ... and the unban still reactivates it: a role change is not a change of status',
  $$ select t.m('k6') = 'Supervisor/active/K-6' $$);

-- k7: the same when the role is changed directly on the membership.
select t.ban('k7');
select t.did('[c40] setup: a banned member''s membership role is changed directly', 'service',
  format('update public.memberships set role = ''Data Logger'' where user_id = %L', t.uid('k7')), 1);
select t.unban('k7');
select t.ok('[c40][c28] ... and the unban still reactivates it',
  $$ select t.m('k7') = 'Data Logger/active/-' $$);

-- k8: no signed-in user can touch the mark or the status at all (criterion 1).
select t.ban('k8');
select t.none('[c40][c1] the banned member cannot clear or set the mark, nor reactivate themselves', 'k8',
  format('update public.memberships set status = ''active'', deactivated_by_ban = false where user_id = %L', t.uid('k8')));

rollback;
select 'done';
