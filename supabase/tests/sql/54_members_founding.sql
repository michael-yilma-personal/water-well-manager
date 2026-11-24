-- SaaS Phase 2, task P2-1: what is special about the FOUNDING organization.
--
--   criterion 8   an account created for another organization never gets a
--                 founding membership (the app_metadata marker)
--   criterion 9   copy-back: role and badge of a founding membership reach
--                 profiles; no other organization's do (D2-3)
--   criterion 10  a status changed by the functions clears the ban mark
--                 (Phase 1 criterion 40); nothing here bans or unbans (D2-5)
--
-- THE MARKER'S KEY. Criterion 8 leaves the name of the app_metadata key to
-- the Developer. It is defined in one place, inc/marker_key.sql (working
-- name `saas_org`), and used here as :'marker_key'.
--
-- The founding organization is the one that exists when this file starts
-- (as in 25_mirroring.sql). Accounts are created the way Supabase Auth
-- creates them: a row in auth.users, with the metadata it would carry.
--
-- Copy-back is asserted for changes made THROUGH THE FUNCTIONS of criterion
-- 3. 25_mirroring.sql (Phase 1, to stay green unchanged) writes a founding
-- membership's role directly and requires the profile to keep its own, so a
-- direct write cannot copy back; this file uses the same direct write to set
-- up a membership and a profile that disagree.
-- plan: 97
begin;
\ir ../lib/helpers.sql
\ir inc/members.sql
\ir inc/marker_key.sql

create table t.founding as select id from public.organizations;
grant select on t.founding to public;
create function t.f() returns uuid language sql stable as $$ select id from t.founding $$;
create function t.s() returns uuid language sql immutable as $$ select t.uid('org_second') $$;

create function t.ban(actor text) returns void
language sql
as $$ update auth.users set banned_until = now() + interval '876000 hours' where id = t.uid(actor) $$;
create function t.unban(actor text) returns void
language sql
as $$ update auth.users set banned_until = null where id = t.uid(actor) $$;

select t.ok('[P2-1] precondition: exactly one organization exists',
  $$ select count(*) = 1 from public.organizations $$);

-- An Administrator of the founding organization, made the way admin-users
-- makes one, so the last-administrator rule has nothing to say below.
insert into auth.users (id, email) values (t.uid('f_admin'), 'f_admin@db-test.invalid');
update public.profiles set role = 'Administrator' where id = t.uid('f_admin');
select t.ok('[P2-1] setup: the founding organization has an active Administrator',
  $$ select t.mo('f_admin', t.f()) = 'Administrator/active/-' $$);

insert into public.organizations (id, name, created_at)
  values (t.s(), 'Second', timestamptz '2000-01-01 00:00:00+00');

-- ---------------------------------------------------------------------------
-- Criterion 8: the marker
-- ---------------------------------------------------------------------------

-- The legacy path (admin-users): no marker.
insert into auth.users (id, email, raw_user_meta_data)
  values (t.uid('n_plain'), 'n_plain@db-test.invalid', '{"name": "Plain", "badge_number": "L-1"}');
select t.ok('[P2-1 c8] an account created with no app_metadata is enrolled in the founding organization, exactly as before',
  $$ select t.m('n_plain') = 'Driller/active/L-1' and t.mo('n_plain', t.f()) = 'Driller/active/L-1' $$);

-- What Supabase Auth always writes, and nothing of ours.
insert into auth.users (id, email, raw_app_meta_data)
  values (t.uid('n_meta'), 'n_meta@db-test.invalid', '{"provider": "email", "providers": ["email"]}');
select t.ok('[P2-1 c8] an account whose app_metadata holds only Supabase''s own keys is enrolled in the founding organization, exactly as before',
  $$ select t.m('n_meta') = 'Driller/active/-' and t.mo('n_meta', t.f()) = 'Driller/active/-' $$);

-- Created for the second organization.
insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  values (t.uid('n_marked'), 'n_marked@db-test.invalid',
          jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email'), :'marker_key', t.s()::text),
          '{"name": "Marked", "badge_number": "U-1"}');
select t.ok('[P2-1 c8] an account created with app_metadata naming another organization still gets its profile',
  $$ select count(*) = 1 from public.profiles where id = t.uid('n_marked') $$);
select t.ok('[P2-1 c8] ... and NO membership in the founding organization',
  $$ select t.mo('n_marked', t.f()) = 'no membership' $$);
select t.none('[P2-1 c8] ... so, signed in before anything else happens, it reads no borehole and is no member of the founding organization', 'n_marked',
  format('select 1 where public.is_org_member(%L) or exists (select 1 from public.boreholes)', t.f()));

-- user_metadata is the user's own to edit: it decides nothing.
insert into auth.users (id, email, raw_user_meta_data)
  values (t.uid('n_user'), 'n_user@db-test.invalid',
          jsonb_build_object('name', 'User', :'marker_key', t.s()::text));
select t.ok('[P2-1 c8] the same key in USER metadata has no influence: the account is enrolled in the founding organization',
  $$ select t.m('n_user') = 'Driller/active/-' and t.mo('n_user', t.f()) = 'Driller/active/-' $$);

insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  values (t.uid('n_both'), 'n_both@db-test.invalid',
          jsonb_build_object('provider', 'email', :'marker_key', t.s()::text),
          jsonb_build_object('name', 'Both', :'marker_key', (select id::text from t.founding)));
select t.ok('[P2-1 c8] app_metadata naming another organization wins over user metadata naming the founding one: no founding membership',
  $$ select t.mo('n_both', t.f()) = 'no membership' $$);

-- What the Edge Function does next: the membership in the organization the
-- account was created for.
select t.mark_audit();
select t.did('[P2-1 c8] the marked account is then added to the organization it was created for (saas_add_member is not refused: no membership was made for it there either)', 'service',
  t.add(t.s(), t.uid('n_marked'), 'Supervisor', 'S-1', 'active', t.uid('f_admin')), 1);
select t.ok('[P2-1 c8] ... and that is its one and only membership',
  $$ select t.m('n_marked') = 'Supervisor/active/S-1' and t.mo('n_marked', t.s()) = 'Supervisor/active/S-1' $$);
select t.audited('[P2-1 c3] ... one audit row, in the second organization',
  t.uid('f_admin'), t.s(), t.uid('n_marked'));
select t.ok('[P2-1 c8] ... its borehole, sent without org_id as an installed build sends it, lands in that organization', 'n_marked',
  format('with i as (%s returning org_id) select org_id = %L from i',
         t.ins('boreholes', t.uid('new:n_marked'), null, t.uid('n_marked')), t.s()));
select t.ok('[P2-1 c9] ... and the legacy profile was not written: a membership outside the founding organization never touches profiles',
  $$ select t.p('n_marked') = 'Driller/U-1' $$);

-- ---------------------------------------------------------------------------
-- Criterion 9: copy-back, founding organization
-- ---------------------------------------------------------------------------

insert into auth.users (id, email, raw_user_meta_data)
  values (t.uid('m1'), 'm1@db-test.invalid', '{"name": "M One", "badge_number": "B-1"}');
select t.ok('[P2-1 c9] setup: a founding member; membership and profile agree',
  $$ select t.mo('m1', t.f()) = 'Driller/active/B-1' and t.p('m1') = 'Driller/B-1' $$);

select t.mark_audit();
select t.did('[P2-1 c9] the role of a founding membership is changed through saas_set_member_role', 'service',
  t.set_role(t.f(), t.uid('m1'), 'Supervisor', t.uid('f_admin')), 1);
select t.ok('[P2-1 c9] ... the membership holds the new role',
  $$ select t.mo('m1', t.f()) = 'Supervisor/active/B-1' $$);
select t.ok('[P2-1 c9] ... and so does profiles.role, where an installed build reads it; the badge is as it was',
  $$ select t.p('m1') = 'Supervisor/B-1' $$);
select t.audited('[P2-1 c9] ... one audit row, not two: the copy and the Phase 1 mirror do not loop',
  t.uid('f_admin'), t.f(), t.uid('m1'));
select t.ok('[P2-1 c9] ... the installed build''s own read agrees: the member reads their profile and it says Supervisor', 'm1',
  format('select role = ''Supervisor'' from public.profiles where id = %L', t.uid('m1')));

select t.did('[P2-1 c9] the badge of a founding membership is changed through saas_set_member_badge', 'service',
  t.set_badge(t.f(), t.uid('m1'), 'B-2', t.uid('f_admin')), 1);
select t.ok('[P2-1 c9] ... membership and profile both hold the new badge, and the role on both is as it was',
  $$ select t.mo('m1', t.f()) = 'Supervisor/active/B-2' and t.p('m1') = 'Supervisor/B-2' $$);
select t.audited('[P2-1 c9] ... one audit row',
  t.uid('f_admin'), t.f(), t.uid('m1'));
select t.did('[P2-1 c9] the badge is cleared through saas_set_member_badge', 'service',
  t.set_badge(t.f(), t.uid('m1'), null, t.uid('f_admin')), 1);
select t.ok('[P2-1 c9] ... and is cleared on both',
  $$ select t.mo('m1', t.f()) = 'Supervisor/active/-' and t.p('m1') = 'Supervisor/-' $$);

-- The other direction still works, and the two take turns without fighting.
select t.did('[P2-1 c9][c9] the Phase 1 mirror still works: the service role sets profiles.role and badge (admin-users)', 'service',
  format('update public.profiles set role = ''Data Logger'', badge_number = ''B-3'' where id = %L', t.uid('m1')), 1);
select t.ok('[P2-1 c9] ... both sides hold the new values',
  $$ select t.mo('m1', t.f()) = 'Data Logger/active/B-3' and t.p('m1') = 'Data Logger/B-3' $$);
select t.did('[P2-1 c9] then the function again', 'service',
  t.set_role(t.f(), t.uid('m1'), 'Driller', t.uid('f_admin')), 1);
select t.ok('[P2-1 c9] ... both sides hold the new role, and the badge the profile set',
  $$ select t.mo('m1', t.f()) = 'Driller/active/B-3' and t.p('m1') = 'Driller/B-3' $$);
select t.did('[P2-1 c9] then the member edits their own badge on the profile, as any signed-in user may', 'm1',
  format('update public.profiles set badge_number = ''B-4'' where id = %L', t.uid('m1')), 1);
select t.ok('[P2-1 c9] ... both sides hold it',
  $$ select t.mo('m1', t.f()) = 'Driller/active/B-4' and t.p('m1') = 'Driller/B-4' $$);

-- Only what changed is copied (Phase 1 criterion 26, now in both directions).
-- m3's membership and profile disagree in role AND badge.
insert into auth.users (id, email, raw_user_meta_data)
  values (t.uid('m3'), 'm3@db-test.invalid', '{"name": "M Three", "badge_number": "P-1"}');
update public.profiles set role = 'Administrator' where id = t.uid('m3');
update public.memberships set role = 'Driller', badge_number = 'M-1' where user_id = t.uid('m3');
select t.ok('[P2-1 c9] setup: the membership says Driller with badge M-1, the legacy profile says Administrator with badge P-1',
  $$ select t.mo('m3', t.f()) = 'Driller/active/M-1' and t.p('m3') = 'Administrator/P-1' $$);

select t.did('[P2-1 c9] a BADGE change through the function, on that member', 'service',
  t.set_badge(t.f(), t.uid('m3'), 'M-2', t.uid('f_admin')), 1);
select t.ok('[P2-1 c9][c26] ... the badge is on both sides',
  $$ select t.mo('m3', t.f()) like '%/active/M-2' and t.p('m3') like '%/M-2' $$);
select t.ok('[P2-1 c9][c26] ... and no ROLE was written: the profile still says Administrator',
  $$ select t.p('m3') = 'Administrator/M-2' $$);
select t.ok('[P2-1 c9][c26] ... and the membership still says Driller (the profile''s Administrator did not come back through the mirror)',
  $$ select t.mo('m3', t.f()) = 'Driller/active/M-2' $$);
select t.none('[P2-1 c9][c26] ... so the member did not become an administrator of the organization', 'm3',
  format('select 1 where public.is_org_admin(%L)', t.f()));

update public.memberships set badge_number = 'M-9' where user_id = t.uid('m3');
select t.ok('[P2-1 c9] setup: the badges disagree again: M-9 on the membership, M-2 on the profile',
  $$ select t.mo('m3', t.f()) = 'Driller/active/M-9' and t.p('m3') = 'Administrator/M-2' $$);
select t.did('[P2-1 c9] a ROLE change through the function, on that member', 'service',
  t.set_role(t.f(), t.uid('m3'), 'Supervisor', t.uid('f_admin')), 1);
select t.ok('[P2-1 c9][c26] ... the role is on both sides',
  $$ select t.mo('m3', t.f()) like 'Supervisor/active/%' and t.p('m3') like 'Supervisor/%' $$);
select t.ok('[P2-1 c9][c26] ... and no BADGE was written: M-9 on the membership, M-2 on the profile, as before',
  $$ select t.mo('m3', t.f()) = 'Supervisor/active/M-9' and t.p('m3') = 'Supervisor/M-2' $$);

-- ASSUMPTION: the role and badge a membership is ADDED with in the founding
-- organization are copied too (D2-3: an installed build must show the role
-- the dashboard gave). The account has no founding membership to begin with.
insert into auth.users (id, email) values (t.uid('m5'), 'm5@db-test.invalid');
delete from public.memberships where user_id = t.uid('m5');
select t.did('[P2-1 c9] an account is added to the founding organization through saas_add_member, as Supervisor with a badge', 'service',
  t.add(t.f(), t.uid('m5'), 'Supervisor', 'A-1', 'active', t.uid('f_admin')), 1);
select t.ok('[P2-1 c9] ... the membership is there',
  $$ select t.m('m5') = 'Supervisor/active/A-1' $$);
select t.ok('[P2-1 c9] ... and the legacy profile shows that role and badge',
  $$ select t.p('m5') = 'Supervisor/A-1' $$);

-- ---------------------------------------------------------------------------
-- Criterion 9: no copy-back from any other organization
-- ---------------------------------------------------------------------------

select t.did('[P2-1 c9] the role of a membership in the SECOND organization is changed through the function', 'service',
  t.set_role(t.s(), t.uid('n_marked'), 'Administrator', t.uid('f_admin')), 1);
select t.did('[P2-1 c9] ... and its badge', 'service',
  t.set_badge(t.s(), t.uid('n_marked'), 'S-2', t.uid('f_admin')), 1);
select t.ok('[P2-1 c9] ... the membership changed',
  $$ select t.m('n_marked') = 'Administrator/active/S-2' $$);
select t.ok('[P2-1 c9] ... and profiles was not touched: still the role and badge the account was created with',
  $$ select t.p('n_marked') = 'Driller/U-1' $$);

-- x2 belongs to both.
insert into auth.users (id, email, raw_user_meta_data)
  values (t.uid('x2'), 'x2@db-test.invalid', '{"name": "X Two", "badge_number": "F-0"}');
insert into public.memberships (org_id, user_id, role, badge_number) values (t.s(), t.uid('x2'), 'Supervisor', 'S-0');
select t.ok('[P2-1 c9] setup: an account in the founding organization (Driller, F-0) and in the second (Supervisor, S-0)',
  $$ select t.mo('x2', t.f()) = 'Driller/active/F-0' and t.mo('x2', t.s()) = 'Supervisor/active/S-0' and t.p('x2') = 'Driller/F-0' $$);
select t.did('[P2-1 c9] its role in the SECOND organization is changed through the function', 'service',
  t.set_role(t.s(), t.uid('x2'), 'Data Logger', t.uid('f_admin')), 1);
select t.did('[P2-1 c9] ... and its badge there', 'service',
  t.set_badge(t.s(), t.uid('x2'), 'S-9', t.uid('f_admin')), 1);
select t.ok('[P2-1 c9] ... the second membership changed',
  $$ select t.mo('x2', t.s()) = 'Data Logger/active/S-9' $$);
select t.ok('[P2-1 c9] ... the profile did not, and neither did the founding membership',
  $$ select t.p('x2') = 'Driller/F-0' and t.mo('x2', t.f()) = 'Driller/active/F-0' $$);
select t.did('[P2-1 c9] its role in the FOUNDING organization is changed through the function', 'service',
  t.set_role(t.f(), t.uid('x2'), 'Supervisor', t.uid('f_admin')), 1);
select t.ok('[P2-1 c9] ... the founding membership and the profile hold it',
  $$ select t.mo('x2', t.f()) = 'Supervisor/active/F-0' and t.p('x2') = 'Supervisor/F-0' $$);
select t.ok('[P2-1 c9][c27] ... and the membership in the second organization was not touched',
  $$ select t.mo('x2', t.s()) = 'Data Logger/active/S-9' $$);

-- ---------------------------------------------------------------------------
-- Criterion 10: the ban mark (Phase 1 criteria 28 and 40), and D2-5
-- ---------------------------------------------------------------------------
-- Asserted by what the mark is FOR, as 27_ban_mark.sql does: whether lifting
-- a ban brings a membership back.

insert into auth.users (id, email)
  select t.uid(a), a || '@db-test.invalid' from unnest(array['k1', 'k2', 'k3', 'k4', 'k5']) a;

-- k1: deactivated by a ban, reactivated through the function while banned.
select t.ban('k1');
select t.ok('[P2-1 c10] setup: a ban deactivated a founding membership',
  $$ select t.mo('k1', t.f()) = 'Driller/deactivated/-' $$);
select t.did('[P2-1 c10] that membership is reactivated through saas_set_member_status, the ban still in force', 'service',
  t.set_status(t.f(), t.uid('k1'), 'active', t.uid('f_admin')), 1);
select t.ok('[P2-1 c10][D2-5] ... the membership is active and the function did not lift the ban',
  $$ select t.mo('k1', t.f()) = 'Driller/active/-'
        and (select banned_until > now() from auth.users where id = t.uid('k1')) $$);
select t.unban('k1');
select t.ok('[P2-1 c10][c40] ... lifting the ban leaves it as it is: active',
  $$ select t.mo('k1', t.f()) = 'Driller/active/-' $$);
select t.ban('k1');
select t.ok('[P2-1 c10] ... a second ban deactivates it again',
  $$ select t.mo('k1', t.f()) = 'Driller/deactivated/-' $$);
select t.unban('k1');
select t.ok('[P2-1 c10][c28] ... and its lifting brings it back',
  $$ select t.mo('k1', t.f()) = 'Driller/active/-' $$);

-- k2: deactivated through the function, account never banned by it.
select t.did('[P2-1 c10] a founding member is deactivated through saas_set_member_status', 'service',
  t.set_status(t.f(), t.uid('k2'), 'deactivated', t.uid('f_admin')), 1);
select t.ok('[P2-1 c10][D2-5] ... deactivated, and the account is NOT banned, in the founding organization too',
  $$ select t.mo('k2', t.f()) = 'Driller/deactivated/-'
        and (select banned_until is null from auth.users where id = t.uid('k2')) $$);
select t.ban('k2');
select t.unban('k2');
select t.ok('[P2-1 c10][c28] ... a later ban and its lifting do NOT reactivate it: the ban is not what deactivated it',
  $$ select t.mo('k2', t.f()) = 'Driller/deactivated/-' $$);

-- k3: deactivated by a ban; then active and deactivated again through the
-- function. The second deactivation is a direct one.
select t.ban('k3');
select t.did('[P2-1 c10] a membership the ban deactivated is reactivated through the function', 'service',
  t.set_status(t.f(), t.uid('k3'), 'active', t.uid('f_admin')), 1);
select t.did('[P2-1 c10] ... and deactivated again through the function', 'service',
  t.set_status(t.f(), t.uid('k3'), 'deactivated', t.uid('f_admin')), 1);
select t.unban('k3');
select t.ok('[P2-1 c10][c40] ... lifting the ban does NOT reactivate it',
  $$ select t.mo('k3', t.f()) = 'Driller/deactivated/-' $$);

-- k4: removed while holding records (so: deactivated), never banned.
select t.did('[P2-1 c10] setup: a founding member logs a borehole', 'k4',
  t.ins('boreholes', t.uid('boreholes:k4'), null, t.uid('k4')), 1);
create table t.k_before as select u.id, to_jsonb(u) as row from auth.users u where u.id in (t.uid('k4'), t.uid('k5'));
select t.ok('[P2-1 c10] saas_remove_member on that member returns ''deactivated''', 'service',
  format('select public.saas_remove_member(%L, %L, %L) = ''deactivated''', t.f(), t.uid('k4'), t.uid('f_admin')));
select t.did('[P2-1 c10] ... done', 'service',
  t.remove(t.f(), t.uid('k4'), t.uid('f_admin')), 1);
select t.ban('k4');
select t.unban('k4');
select t.ok('[P2-1 c10][c28] ... a later ban and its lifting do NOT reactivate it',
  $$ select t.mo('k4', t.f()) = 'Driller/deactivated/-' $$);

-- k5: removed with no records.
select t.ok('[P2-1 c10] saas_remove_member on a founding member with no records returns ''removed''', 'service',
  format('select public.saas_remove_member(%L, %L, %L) = ''removed''', t.f(), t.uid('k5'), t.uid('f_admin')));
select t.did('[P2-1 c10] ... done', 'service',
  t.remove(t.f(), t.uid('k5'), t.uid('f_admin')), 1);
select t.ok('[P2-1 c10][D2-5] ... the membership is gone; the auth account is still there, the row it was, and not banned',
  $$ select t.m('k5') = 'no membership'
        and (select to_jsonb(u) = b.row and u.banned_until is null from auth.users u join t.k_before b on b.id = u.id where u.id = t.uid('k5')) $$);
select t.ban('k5');
select t.unban('k5');
select t.ok('[P2-1 c10][c31] ... and a later ban and its lifting do not enrol the removed member again',
  $$ select t.m('k5') = 'no membership' $$);

-- ---------------------------------------------------------------------------
-- Section C (criteria 14 and 17 to 20), added in validation
-- ---------------------------------------------------------------------------

-- Criterion 17: n_plain has no membership in the second organization.
select t.refused(format('[P2-1 c17] %s: RAISES for a user with no membership in the organization', fn), 'service', q, fn, null)
from (values ('badge',  t.set_badge(t.s(), t.uid('n_plain'), 'X-1', t.uid('f_admin'))),
             ('status', t.set_status(t.s(), t.uid('n_plain'), 'deactivated', t.uid('f_admin'))),
             ('remove', t.remove(t.s(), t.uid('n_plain'), t.uid('f_admin')))) v(fn, q);

-- Criterion 18: the second organization is left with no active administrator.
update public.memberships set status = 'deactivated' where org_id = t.s() and user_id = t.uid('n_marked');
select t.did('[P2-1 c18] in an organization that already has no active administrator, another member can still be deactivated', 'service',
  t.set_status(t.s(), t.uid('x2'), 'deactivated', t.uid('f_admin')), 1);

-- The hook the copy-back hangs on writes profiles.role: not for clients.
select t.ok('[P2-1 c11] anon and authenticated hold no EXECUTE on saas_member_changing',
  $$ select count(*) = 1 and not bool_or(has_function_privilege('anon', oid, 'EXECUTE') or has_function_privilege('authenticated', oid, 'EXECUTE'))
     from pg_proc where pronamespace = 'public'::regnamespace and proname = 'saas_member_changing' $$);

-- Criterion 19: a ban deactivated the membership; then an Administrator does.
insert into auth.users (id, email) select t.uid(a), a || '@db-test.invalid' from unnest(array['k6', 'k7']) a;
select t.did('[P2-1 c19] setup: a founding member logs a borehole', 'k7',
  t.ins('boreholes', t.uid('boreholes:k7'), null, t.uid('k7')), 1);
select t.ban('k6');
select t.ban('k7');
select t.ok('[P2-1 c19] setup: a ban deactivated both founding memberships',
  $$ select t.mo('k6', t.f()) = 'Driller/deactivated/-' and t.mo('k7', t.f()) = 'Driller/deactivated/-' $$);
select t.did('[P2-1 c19] the first is deactivated through saas_set_member_status, the ban still in force', 'service',
  t.set_status(t.f(), t.uid('k6'), 'deactivated', t.uid('f_admin')), 1);
select t.did('[P2-1 c19] the second, who has records, is removed through saas_remove_member', 'service',
  t.remove(t.f(), t.uid('k7'), t.uid('f_admin')), 1);
select t.unban('k6');
select t.unban('k7');
select t.ok('[P2-1 c19] ... lifting the ban does NOT bring back the one deactivated on purpose',
  $$ select t.mo('k6', t.f()) = 'Driller/deactivated/-' $$);
select t.ok('[P2-1 c19] ... nor the one removed (kept, deactivated)',
  $$ select t.mo('k7', t.f()) = 'Driller/deactivated/-' $$);

-- Criterion 20: an invitation to the founding organization, for an account
-- created for another company.
insert into auth.users (id, email, raw_app_meta_data, raw_user_meta_data)
  values (t.uid('i1'), 'i1@db-test.invalid', jsonb_build_object(:'marker_key', t.s()::text), '{"badge_number": "P-0"}');
select t.did('[P2-1 c20] an account is INVITED to the founding organization as Supervisor with a badge', 'service',
  t.add(t.f(), t.uid('i1'), 'Supervisor', 'I-1', 'invited', t.uid('f_admin')), 1);
select t.did('[P2-1 c20] ... the invitation''s role is changed', 'service',
  t.set_role(t.f(), t.uid('i1'), 'Administrator', t.uid('f_admin')), 1);
select t.did('[P2-1 c20] ... and its badge', 'service',
  t.set_badge(t.f(), t.uid('i1'), 'I-2', t.uid('f_admin')), 1);
select t.ok('[P2-1 c20] ... none of the three wrote the profile',
  $$ select t.mo('i1', t.f()) = 'Administrator/invited/I-2' and t.p('i1') = 'Driller/P-0' $$);
select t.did('[P2-1 c20] the invited person accepts', 'i1',
  format('select public.accept_membership(%L)', t.f()), 1);
select t.ok('[P2-1 c20] ... the membership is active and accepting wrote nothing to the profile either',
  $$ select t.mo('i1', t.f()) = 'Administrator/active/I-2' and t.p('i1') = 'Driller/P-0' $$);

-- Criterion 8, in the order Supabase Auth really writes (admin createUser,
-- internal/api/admin.go): the row is INSERTED with provider/providers only,
-- and the app_metadata of the request is added by an UPDATE in the same
-- transaction.
insert into auth.users (id, email, raw_app_meta_data)
  values (t.uid('n_seq'), 'n_seq@db-test.invalid', '{"provider": "email", "providers": ["email"]}');
update auth.users set raw_app_meta_data = raw_app_meta_data || jsonb_build_object(:'marker_key', t.s()::text)
  where id = t.uid('n_seq');
select t.ok('[P2-1 c8] the marker written the way Supabase Auth writes it (insert, then update, one transaction): NO founding membership',
  $$ select t.mo('n_seq', t.f()) = 'no membership' $$);

-- Criterion 14: the key counts, whatever its value.
insert into auth.users (id, email, raw_app_meta_data)
  select t.uid(a), a || '@db-test.invalid', jsonb_build_object(:'marker_key', v)
  from (values ('v_founding', t.f()::text), ('v_unknown', t.uid('no_such_org')::text), ('v_text', 'not an id')) x(a, v);
select t.ok('[P2-1 c14] a marker naming the founding organization, an unknown id, or text that is no id: a profile each, and no membership anywhere',
  $$ select (select count(*) from public.profiles where id in (t.uid('v_founding'), t.uid('v_unknown'), t.uid('v_text'))) = 3
        and t.m('v_founding') = 'no membership' and t.m('v_unknown') = 'no membership' and t.m('v_text') = 'no membership' $$);

-- Criterion 14: drill_tenancy applied again as a FIRST application (the
-- founding organization emptied, Phase 1 criterion 45). Last in this file:
-- the file puts the Phase 1 enrolment function back (criterion 21).
delete from public.memberships where org_id = t.f();
\i :mig_drill
select t.ok('[P2-1 c14] control: that application enrolled the accounts with no marker again',
  $$ select t.mo('n_plain', t.f()) = 'Driller/active/L-1' $$);
select t.ok('[P2-1 c14] ... and no marked account: still no membership anywhere',
  $$ select t.m('v_founding') = 'no membership' and t.m('v_unknown') = 'no membership' and t.m('v_text') = 'no membership'
        and t.m('n_both') = 'no membership' $$);

rollback;
select 'done';
