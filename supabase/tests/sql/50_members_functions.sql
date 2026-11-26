-- SaaS Phase 2, task P2-1: the member-management functions.
--
--   criterion 1   saas_roles()
--   criterion 2   saas_member_record_count(org, member)
--   criterion 3   saas_add_member, saas_set_member_role, saas_set_member_badge,
--                 saas_set_member_status, saas_remove_member
--   criterion 6   the actor argument is recorded, not trusted
--   criterion 7   Drill's vocabulary and Drill's record count
--   criterion 11  no new privilege for clients
--   criterion 12  nothing crosses an organization
--
-- Written before the migrations exist, from the criteria only. Where they
-- say "a distinguishable error code or message" no SQLSTATE is assumed: a
-- refusal must raise (t.refused; an error that only says the call is broken
-- does not count), and the refusals of one function must differ from each
-- other in SQLSTATE or message (t.distinguishable).
--
-- Readings taken where the criteria are silent; each is marked ASSUMPTION at
-- the check and listed in the Test Engineer's report:
--   - saas_add_member refuses a status other than active or invited, and
--     saas_set_member_status one other than active or deactivated;
--   - saas_set_member_badge has no self rule (none is listed for it);
--   - for a user with no membership in the organization, only
--     saas_set_member_role is REQUIRED to raise (the criteria list it there
--     only); the other three are required to change nothing.
-- plan: 216
begin;
\ir ../lib/helpers.sql
\ir ../lib/fixture.sql
\ir inc/members.sql

create function t.a() returns uuid language sql immutable as $$ select t.uid('org_a') $$;
create function t.b() returns uuid language sql immutable as $$ select t.uid('org_b') $$;

-- ---------------------------------------------------------------------------
-- Criteria 1, 2, 3, 5: the functions exist, and who may execute them
-- ---------------------------------------------------------------------------
-- Looked up by name, so nothing is assumed about parameter names. EXECUTE is
-- read with has_function_privilege(), which sees a grant to PUBLIC too.
-- svc is null where the criteria do not say (accept / decline are "callable
-- by authenticated (not anon)").

create table t.fns (name text primary key, nargs int, anon boolean, auth boolean, svc boolean, crit text);
insert into t.fns values
  ('saas_roles',               0, false, true,  true,  'c1'),
  ('saas_member_record_count', 2, false, false, true,  'c2'),
  ('saas_add_member',          6, false, false, true,  'c3'),
  ('saas_set_member_role',     4, false, false, true,  'c3'),
  ('saas_set_member_badge',    4, false, false, true,  'c3'),
  ('saas_set_member_status',   4, false, false, true,  'c3'),
  ('saas_remove_member',       3, false, false, true,  'c3'),
  ('accept_membership',        1, false, true,  null,  'c5'),
  ('decline_membership',       1, false, true,  null,  'c5');

select t.ok(format('[P2-1 %s] public.%s exists, once, with %s argument(s)', crit, name, nargs),
  format($$ select count(*) = 1 and bool_and(pronargs = %s) from pg_proc where pronamespace = 'public'::regnamespace and proname = %L $$, nargs, name))
from t.fns order by name;

select t.ok(format('[P2-1 %s] %s %s EXECUTE on %s', f.crit, r.role, case when r.may then 'holds' else 'holds no' end, f.name),
  format($$ select count(*) = 1 and bool_and(has_function_privilege(%L, oid, 'EXECUTE') = %L::boolean)
            from pg_proc where pronamespace = 'public'::regnamespace and proname = %L $$, r.role, r.may, f.name))
from t.fns f
cross join lateral (values ('anon', f.anon), ('authenticated', f.auth), ('service_role', f.svc)) r(role, may)
where r.may is not null
order by f.name, r.role;

select t.ok('[P2-1 c1] saas_roles() is stable, security definer, with search_path = public, and returns text[]',
  $$ select count(*) = 1 and bool_and(provolatile = 's' and prosecdef and proconfig @> array['search_path=public'] and prorettype = 'text[]'::regtype)
     from pg_proc where pronamespace = 'public'::regnamespace and proname = 'saas_roles' $$);
select t.ok('[P2-1 c2] saas_member_record_count(uuid, uuid) returns bigint',
  $$ select to_regprocedure('public.saas_member_record_count(uuid,uuid)') is not null
        and (select prorettype = 'bigint'::regtype from pg_proc where oid = to_regprocedure('public.saas_member_record_count(uuid,uuid)')) $$);
select t.ok('[P2-1 c3] saas_remove_member returns text',
  $$ select count(*) = 1 and bool_and(prorettype = 'text'::regtype)
     from pg_proc where pronamespace = 'public'::regnamespace and proname = 'saas_remove_member' $$);

-- In use. Every call below would succeed for the service role (the positive
-- checks further down prove it), so the only reason to fail here is the caller.
create table t.calls (fn text primary key, q text);
insert into t.calls values
  ('saas_member_record_count', format('select public.saas_member_record_count(%L, %L)', t.a(), t.uid('a_driller'))),
  ('saas_add_member',          t.add(t.a(), t.uid('stranger'), 'Driller', null, 'active', t.uid('a_admin'))),
  ('saas_set_member_role',     t.set_role(t.a(), t.uid('a_driller'), 'Supervisor', t.uid('a_admin'))),
  ('saas_set_member_badge',    t.set_badge(t.a(), t.uid('a_driller'), 'X-1', t.uid('a_admin'))),
  ('saas_set_member_status',   t.set_status(t.a(), t.uid('a_driller'), 'deactivated', t.uid('a_admin'))),
  ('saas_remove_member',       t.remove(t.a(), t.uid('a_driller'), t.uid('a_admin')));

select t.throws(format('[P2-1 %s] %s cannot call %s: 42501', case when c.fn = 'saas_member_record_count' then 'c2' else 'c3' end, w.who, c.fn),
  w.actor, c.q, '42501')
from t.calls c
cross join (values ('a_admin', 'the organization''s own Administrator, signed in,'),
                   ('padmin',  'a platform administrator, signed in,'),
                   ('anon',    'a signed-out client')) w(actor, who)
order by c.fn, w.actor;

select t.throws('[P2-1 c1] a signed-out client cannot call saas_roles(): 42501', 'anon',
  $$ select public.saas_roles() $$, '42501');

-- ---------------------------------------------------------------------------
-- Criterion 7: Drill's roles and Drill's record count
-- ---------------------------------------------------------------------------

select t.ok('[P2-1 c7] saas_roles() returns the four Drill roles and nothing else (asked by a signed-in member)', 'a_driller',
  $$ select (select array_agg(r order by r) from unnest(public.saas_roles()) r)
            = array['Administrator', 'Data Logger', 'Driller', 'Supervisor'] $$);
select t.ok('[P2-1 c7] ... and the same to the service role', 'service',
  $$ select (select array_agg(r order by r) from unnest(public.saas_roles()) r)
            = array['Administrator', 'Data Logger', 'Driller', 'Supervisor'] $$);

-- The fixture gives each author one borehole, one pipe record, one event and
-- one shift log per set.
select t.ok(format('[P2-1 c7] saas_member_record_count(%s, %s) = %s: %s', org, actor, n, why), 'service',
  format('select public.saas_member_record_count(%L, %L) = %s', t.uid(org), t.uid(actor), n))
from (values
  ('org_a', 'a_driller', 4, 'a row in each of the four record tables'),
  ('org_b', 'a_driller', 0, 'their records are in the other organization'),
  ('org_a', 'dual',      4, 'only the records of THIS organization, for an author with records in both'),
  ('org_b', 'dual',      4, 'only the records of THIS organization, for an author with records in both (other direction)'),
  ('org_a', 'a_exsuper', 0, 'a member with no records'),
  ('org_a', 'b_driller', 0, 'not a member here, records elsewhere'),
  ('org_a', 'stranger',  0, 'an account with no membership and no records')) v(org, actor, n, why);
select t.ok('[P2-1 c7] saas_member_record_count for an organization that does not exist is 0', 'service',
  format('select public.saas_member_record_count(%L, %L) = 0', t.uid('no_such_org'), t.uid('a_driller')));

-- Each table on its own: a_exsuper (no records so far) authors one row at a
-- time, the children under somebody else's borehole.
select t.did('[P2-1 c7] setup: a_exsuper authors a borehole in org A', null,
  t.ins('boreholes', t.uid('c7:boreholes'), null, t.uid('a_exsuper'), t.a()), 1);
select t.ok('[P2-1 c7] ... a borehole counts: 1', 'service',
  format('select public.saas_member_record_count(%L, %L) = 1', t.a(), t.uid('a_exsuper')));
select t.did('[P2-1 c7] setup: a_exsuper authors a pipe record under another member''s borehole', null,
  t.ins('pipe_records', t.uid('c7:pipe_records'), t.rid('boreholes', 'a_driller'), t.uid('a_exsuper'), t.a()), 1);
select t.ok('[P2-1 c7] ... a pipe record counts: 2', 'service',
  format('select public.saas_member_record_count(%L, %L) = 2', t.a(), t.uid('a_exsuper')));
select t.did('[P2-1 c7] setup: a_exsuper authors a drilling event under another member''s borehole', null,
  t.ins('drilling_events', t.uid('c7:drilling_events'), t.rid('boreholes', 'a_driller'), t.uid('a_exsuper'), t.a()), 1);
select t.ok('[P2-1 c7] ... a drilling event counts: 3', 'service',
  format('select public.saas_member_record_count(%L, %L) = 3', t.a(), t.uid('a_exsuper')));
select t.did('[P2-1 c7] setup: a_exsuper authors a shift log under another member''s borehole', null,
  t.ins('shift_logs', t.uid('c7:shift_logs'), t.rid('boreholes', 'a_driller'), t.uid('a_exsuper'), t.a()), 1);
select t.ok('[P2-1 c7] ... a shift log counts: 4', 'service',
  format('select public.saas_member_record_count(%L, %L) = 4', t.a(), t.uid('a_exsuper')));
select t.ok('[P2-1 c7] ... and the owner of the borehole those rows hang under still has 4, not 7: created_by decides, not the borehole', 'service',
  format('select public.saas_member_record_count(%L, %L) = 4', t.a(), t.uid('a_driller')));

update public.boreholes       set deleted_at = now() where id = t.uid('c7:boreholes');
update public.pipe_records    set deleted_at = now() where id = t.uid('c7:pipe_records');
update public.drilling_events set deleted_at = now() where id = t.uid('c7:drilling_events');
update public.shift_logs      set deleted_at = now() where id = t.uid('c7:shift_logs');
select t.ok('[P2-1 c7] soft-deleted rows are included: still 4 once all four are soft-deleted', 'service',
  format('select (select count(*) from public.boreholes where created_by = %2$L and deleted_at is not null) = 1
             and public.saas_member_record_count(%1$L, %2$L) = 4', t.a(), t.uid('a_exsuper')));

-- ---------------------------------------------------------------------------
-- Criterion 3: saas_add_member
-- ---------------------------------------------------------------------------

select t.mark_audit();
select t.did('[P2-1 c3] add: the service role adds an account with no membership to org A as an active Driller with a badge', 'service',
  t.add(t.a(), t.uid('stranger'), 'Driller', 'N-1', 'active', t.uid('a_admin')), 1);
select t.ok('[P2-1 c3] ... the membership is there with that role, status and badge, and it is the account''s only one',
  $$ select t.mo('stranger', t.a()) = 'Driller/active/N-1' and t.m('stranger') = 'Driller/active/N-1' $$);
select t.audited('[P2-1 c3] ... one audit row: the actor, the organization, target = the member''s user id, an action',
  t.uid('a_admin'), t.a(), t.uid('stranger'));
select t.ok('[P2-1 c3] ... and the membership works: the new member''s borehole, sent without org_id, lands in org A', 'stranger',
  format('with i as (%s returning org_id) select org_id = %L from i',
         t.ins('boreholes', t.uid('new:stranger'), null, t.uid('stranger')), t.a()));

-- D2-1: an account that already works elsewhere is added as `invited`.
select t.did('[P2-1 c3] add: a member of org B is added to org A as an invited Supervisor, without a badge', 'service',
  t.add(t.a(), t.uid('b_driller'), 'Supervisor', null, 'invited', t.uid('a_admin')), 1);
select t.ok('[P2-1 c3] ... the invitation is there, and their membership in org B is as it was',
  $$ select t.mo('b_driller', t.a()) = 'Supervisor/invited/-' and t.mo('b_driller', t.b()) = 'Driller/active/-' $$);
select t.audited('[P2-1 c3] ... one audit row, in org A',
  t.uid('a_admin'), t.a(), t.uid('b_driller'));
select t.none('[P2-1 c3][D2-1] ... an invitation gives nothing: the invited Supervisor reads no borehole of org A', 'b_driller',
  format('select id from public.boreholes where org_id = %L', t.a()));
select t.none('[P2-1 c3][D2-1] ... and is not a member of org A', 'b_driller',
  format('select 1 where public.is_org_member(%L)', t.a()));
select t.ok('[P2-1 c3][D2-1] ... and takes nothing: their borehole sent without org_id (an installed build) still lands in org B', 'b_driller',
  format('with i as (%s returning org_id) select org_id = %L from i',
         t.ins('boreholes', t.uid('new:b_driller'), null, t.uid('b_driller')), t.b()));
select t.ok('[P2-1 c3] ... my_organizations() shows the invited person the invitation, so an app can offer to accept it', 'b_driller',
  format($$ select count(*) = 1 from public.my_organizations() where org_id = %L and status = 'invited' and role = 'Supervisor' $$, t.a()));

select t.rows(format('[P2-1 c3] add: the role "%s" is accepted', r), 'service',
  t.add(t.a(), t.uid('padmin'), r, null, 'active', t.uid('a_admin')), 1)
from (values ('Driller'), ('Data Logger'), ('Supervisor'), ('Administrator')) v(r);

select t.refused('[P2-1 c3] add: refused when the organization does not exist', 'service',
  t.add(t.uid('no_such_org'), t.uid('padmin'), 'Driller', null, 'active', t.uid('a_admin')), 'add', 'organization');
select t.refused('[P2-1 c3] add: refused when the organization is null', 'service',
  t.add(null, t.uid('padmin'), 'Driller', null, 'active', t.uid('a_admin')), 'add', null);
select t.refused('[P2-1 c3] add: refused for the role "admin" (the foundation''s default, not one of saas_roles() here)', 'service',
  t.add(t.a(), t.uid('padmin'), 'admin', null, 'active', t.uid('a_admin')), 'add', 'role');
select t.refused(format('[P2-1 c3] add: refused for the role %s', coalesce('"' || r || '"', 'null')), 'service',
  t.add(t.a(), t.uid('padmin'), r, null, 'active', t.uid('a_admin')), 'add', null)
from (values ('driller'), (''), (' Driller'), ('member'), ('Driller,Administrator'), (null)) v(r);
select t.refused('[P2-1 c3] add: refused when the user already has an ACTIVE membership in the organization', 'service',
  t.add(t.a(), t.uid('a_driller'), 'Supervisor', null, 'active', t.uid('a_admin')), 'add', 'exists');
select t.refused('[P2-1 c3] add: refused when the user already has a DEACTIVATED membership there (it is not a way to reactivate)', 'service',
  t.add(t.a(), t.uid('a_gone'), 'Driller', null, 'active', t.uid('a_admin')), 'add', null);
select t.refused('[P2-1 c3] add: refused when the user already has an INVITED membership there (it is not a way to accept for them)', 'service',
  t.add(t.a(), t.uid('a_invited'), 'Supervisor', null, 'active', t.uid('a_admin')), 'add', null);
select t.ok('[P2-1 c3] ... and those three memberships are what they were',
  $$ select t.mo('a_driller', t.a()) = 'Driller/active/-' and t.mo('a_gone', t.a()) = 'Driller/deactivated/-'
        and t.mo('a_invited', t.a()) = 'Supervisor/invited/-' $$);
-- ASSUMPTION: "inserts a membership with status active or invited" means no other status is taken.
select t.refused(format('[P2-1 c3] add: refused for the status "%s" (only active or invited)', s), 'service',
  t.add(t.a(), t.uid('padmin'), 'Driller', null, s, t.uid('a_admin')), 'add', null)
from (values ('deactivated'), ('Active'), ('')) v(s);
select t.refused('[P2-1 c3] add: refused for a user id that is no account', 'service',
  t.add(t.a(), t.uid('no_such_account'), 'Driller', null, 'active', t.uid('a_admin')), 'add', null);
select t.distinguishable('[P2-1 c3] add: its three refusals (no such organization, unknown role, already a member) can be told apart', 'add', 3);

-- Criterion 6: the actor is recorded, not checked.
select t.rows(format('[P2-1 c6] add: accepted with %s as the actor (authorization is the Edge Function''s job)', why), 'service',
  t.add(t.a(), t.uid('padmin'), 'Driller', null, 'active', t.uid(actor)), 1)
from (values ('a_driller', 'a Driller of the organization'),
             ('b_admin',   'the Administrator of another organization'),
             ('a_gone',    'a deactivated member'),
             ('b_super',   'an account that is no member of it')) v(actor, why);
select t.mark_audit();
select t.did('[P2-1 c6] add: done with a Driller as the actor', 'service',
  t.add(t.a(), t.uid('padmin'), 'Data Logger', 'P-1', 'active', t.uid('a_driller')), 1);
select t.audited('[P2-1 c6] ... and the audit row names that Driller as the actor: recorded as given',
  t.uid('a_driller'), t.a(), t.uid('padmin'));

-- ---------------------------------------------------------------------------
-- Criterion 3: saas_set_member_role
-- ---------------------------------------------------------------------------
-- Org A now: a_admin is its only ACTIVE Administrator (a_exadmin and mixed are
-- deactivated Administrators).

select t.ok('[P2-1 c3] role: setup: org A has exactly one active Administrator, and two deactivated ones',
  $$ select count(*) filter (where status = 'active') = 1 and count(*) filter (where status = 'deactivated') = 2
     from public.memberships where org_id = t.a() and role = 'Administrator' $$);

select t.did('[P2-1 c3] role: setup: a Driller has a badge (written directly)', null,
  format('update public.memberships set badge_number = ''D-2'' where org_id = %L and user_id = %L', t.a(), t.uid('a_driller2')), 1);
select t.mark_audit();
select t.did('[P2-1 c3] role: a Driller with a badge is made Data Logger', 'service',
  t.set_role(t.a(), t.uid('a_driller2'), 'Data Logger', t.uid('a_admin')), 1);
select t.ok('[P2-1 c3] ... the role changed; status and badge did not',
  $$ select t.mo('a_driller2', t.a()) = 'Data Logger/active/D-2' $$);
select t.audited('[P2-1 c3] ... one audit row', t.uid('a_admin'), t.a(), t.uid('a_driller2'));
select t.rows(format('[P2-1 c3] role: the role "%s" is accepted', r), 'service',
  t.set_role(t.a(), t.uid('a_logger'), r, t.uid('a_admin')), 1)
from (values ('Driller'), ('Data Logger'), ('Supervisor'), ('Administrator')) v(r);
select t.rows('[P2-1 c3] role: the role of a deactivated member can be changed', 'service',
  t.set_role(t.a(), t.uid('a_gone'), 'Data Logger', t.uid('a_admin')), 1);

select t.refused('[P2-1 c3] role: refused for the role "admin"', 'service',
  t.set_role(t.a(), t.uid('a_logger'), 'admin', t.uid('a_admin')), 'role', 'role');
select t.refused(format('[P2-1 c3] role: refused for the role %s', coalesce('"' || r || '"', 'null')), 'service',
  t.set_role(t.a(), t.uid('a_logger'), r, t.uid('a_admin')), 'role', null)
from (values ('supervisor'), (''), ('Owner'), (null)) v(r);
select t.refused('[P2-1 c3][P2-1 c12] role: refused for a user with no membership in the organization (a member of org B, asked through org A)', 'service',
  t.set_role(t.a(), t.uid('b_super'), 'Driller', t.uid('a_admin')), 'role', 'no membership');
select t.ok('[P2-1 c12] ... and their membership in org B is what it was',
  $$ select t.m('b_super') = 'Supervisor/active/-' $$);
select t.refused('[P2-1 c3] role: refused for a user id that is no account', 'service',
  t.set_role(t.a(), t.uid('no_such_account'), 'Driller', t.uid('a_admin')), 'role', null);
select t.refused('[P2-1 c3] role: refused when member = actor (a Supervisor changing their own role; no other rule is involved)', 'service',
  t.set_role(t.a(), t.uid('a_super'), 'Driller', t.uid('a_super')), 'role', 'self');
select t.refused('[P2-1 c3] role: refused when member = actor, also to promote oneself', 'service',
  t.set_role(t.a(), t.uid('a_super'), 'Administrator', t.uid('a_super')), 'role', null);
select t.refused('[P2-1 c3] role: refused when it would demote the only active Administrator (asked by somebody else)', 'service',
  t.set_role(t.a(), t.uid('a_admin'), 'Supervisor', t.uid('a_super')), 'role', 'last administrator');
select t.ok('[P2-1 c3] ... a deactivated Administrator does not count as one: a_admin is still Administrator',
  $$ select t.mo('a_admin', t.a()) = 'Administrator/active/-' $$);
select t.rows('[P2-1 c3] role: a DEACTIVATED Administrator can be demoted while one active Administrator remains', 'service',
  t.set_role(t.a(), t.uid('a_exadmin'), 'Driller', t.uid('a_admin')), 1);
select t.did('[P2-1 c3] role: setup: an INVITED Administrator joins org A (written directly)', null,
  format('insert into public.memberships (org_id, user_id, role, status) values (%L, %L, ''Administrator'', ''invited'')', t.a(), t.uid('b_admin')), 1);
select t.refused('[P2-1 c3] role: an invited Administrator does not count either: demoting the only active one is still refused', 'service',
  t.set_role(t.a(), t.uid('a_admin'), 'Supervisor', t.uid('a_super')), 'role', null);
-- The invitation was only for the check above; b_admin belongs to org B alone again.
delete from public.memberships where org_id = t.a() and user_id = t.uid('b_admin');
select t.refused('[P2-1 c12] role: the Administrator of org B does not count for org A: still refused with b_admin active in B', 'service',
  t.set_role(t.a(), t.uid('a_admin'), 'Driller', t.uid('a_driller')), 'role', null);
select t.distinguishable('[P2-1 c3] role: its four refusals (unknown role, no membership, self, last administrator) can be told apart', 'role', 4);

select t.mark_audit();
select t.did('[P2-1 c3] role: a Supervisor is promoted to Administrator', 'service',
  t.set_role(t.a(), t.uid('a_super'), 'Administrator', t.uid('a_admin')), 1);
select t.audited('[P2-1 c3] ... one audit row', t.uid('a_admin'), t.a(), t.uid('a_super'));
select t.rows('[P2-1 c3] role: with two active Administrators, one of them can be demoted by the other', 'service',
  t.set_role(t.a(), t.uid('a_admin'), 'Supervisor', t.uid('a_super')), 1);
select t.refused('[P2-1 c3] role: ... but still not by themselves', 'service',
  t.set_role(t.a(), t.uid('a_admin'), 'Supervisor', t.uid('a_admin')), 'role', null);

-- ---------------------------------------------------------------------------
-- Criterion 3: saas_set_member_badge
-- ---------------------------------------------------------------------------

select t.mark_audit();
select t.did('[P2-1 c3] badge: a member is given a badge', 'service',
  t.set_badge(t.a(), t.uid('a_driller'), 'B-10', t.uid('a_admin')), 1);
select t.ok('[P2-1 c3] ... the badge changed; role and status did not',
  $$ select t.mo('a_driller', t.a()) = 'Driller/active/B-10' $$);
select t.audited('[P2-1 c3] ... one audit row', t.uid('a_admin'), t.a(), t.uid('a_driller'));
select t.did('[P2-1 c3] badge: the badge is cleared with null', 'service',
  t.set_badge(t.a(), t.uid('a_driller'), null, t.uid('a_admin')), 1);
select t.ok('[P2-1 c3] ... and is null on the membership',
  $$ select t.mo('a_driller', t.a()) = 'Driller/active/-' $$);
-- ASSUMPTION: no self rule is listed for the badge, so an Administrator may set their own.
select t.rows('[P2-1 c3] badge: member = actor is allowed (the self rules are listed for role, status and removal only)', 'service',
  t.set_badge(t.a(), t.uid('a_admin'), 'A-1', t.uid('a_admin')), 1);
select t.no_change('[P2-1 c12] badge: for a member of org B asked through org A, nothing changes anywhere', 'service',
  t.set_badge(t.a(), t.uid('b_super'), 'HACK', t.uid('a_admin')));
select t.no_change('[P2-1 c3] badge: for a user id that is no account, nothing changes', 'service',
  t.set_badge(t.a(), t.uid('no_such_account'), 'HACK', t.uid('a_admin')));

-- ---------------------------------------------------------------------------
-- Criterion 3: saas_set_member_status
-- ---------------------------------------------------------------------------
-- Org A now has two active Administrators: a_admin and a_super.

select t.mark_audit();
select t.did('[P2-1 c3] status: a Driller is deactivated', 'service',
  t.set_status(t.a(), t.uid('a_driller'), 'deactivated', t.uid('a_admin')), 1);
select t.ok('[P2-1 c3] ... the status changed; role and badge did not',
  $$ select t.mo('a_driller', t.a()) = 'Driller/deactivated/-' $$);
select t.audited('[P2-1 c3] ... one audit row', t.uid('a_admin'), t.a(), t.uid('a_driller'));
select t.none('[P2-1 c3] ... and it bites: the deactivated Driller reads none of their own boreholes', 'a_driller',
  $$ select id from public.boreholes $$);
select t.ok('[P2-1 c10][D2-5] ... the account itself is not banned',
  $$ select banned_until is null from auth.users where id = t.uid('a_driller') $$);
select t.did('[P2-1 c3] status: and reactivated', 'service',
  t.set_status(t.a(), t.uid('a_driller'), 'active', t.uid('a_admin')), 1);
select t.audited('[P2-1 c3] ... one audit row', t.uid('a_admin'), t.a(), t.uid('a_driller'));
select t.rows('[P2-1 c3] ... and reads their borehole again', 'a_driller',
  format('select id from public.boreholes where id = %L', t.rid('boreholes', 'a_driller')), 1);

select t.refused('[P2-1 c3] status: refused when member = actor (a Data Logger deactivating themselves; no other rule is involved)', 'service',
  t.set_status(t.a(), t.uid('a_logger'), 'deactivated', t.uid('a_logger')), 'status', 'self');
select t.refused('[P2-1 c3][D2-1] status: refused for an INVITED membership: nobody else activates an invitation', 'service',
  t.set_status(t.a(), t.uid('a_invited'), 'active', t.uid('a_admin')), 'status', 'invited');
select t.refused('[P2-1 c3] status: refused for an invited membership, also to deactivate it (it is accepted or removed)', 'service',
  t.set_status(t.a(), t.uid('a_invited'), 'deactivated', t.uid('a_admin')), 'status', null);
select t.refused('[P2-1 c3][D2-1] status: refused for the invitation that saas_add_member wrote for a member of org B', 'service',
  t.set_status(t.a(), t.uid('b_driller'), 'active', t.uid('a_admin')), 'status', null);
select t.ok('[P2-1 c3] ... both invitations are still invitations',
  $$ select t.mo('a_invited', t.a()) = 'Supervisor/invited/-' and t.mo('b_driller', t.a()) = 'Supervisor/invited/-' $$);
-- ASSUMPTION: "with active or deactivated" means no other status is taken.
select t.refused(format('[P2-1 c3] status: refused for the status "%s" (only active or deactivated)', s), 'service',
  t.set_status(t.a(), t.uid('a_logger'), s, t.uid('a_admin')), 'status', null)
from (values ('invited'), ('banned'), ('')) v(s);
select t.no_change('[P2-1 c12] status: for a member of org B asked through org A, nothing changes anywhere', 'service',
  t.set_status(t.a(), t.uid('b_super'), 'deactivated', t.uid('a_admin')));

select t.did('[P2-1 c3] status: with two active Administrators, one can be deactivated by the other', 'service',
  t.set_status(t.a(), t.uid('a_super'), 'deactivated', t.uid('a_admin')), 1);
select t.refused('[P2-1 c3] status: refused when it would deactivate the only active Administrator (asked by somebody else)', 'service',
  t.set_status(t.a(), t.uid('a_admin'), 'deactivated', t.uid('a_driller')), 'status', 'last administrator');
select t.ok('[P2-1 c3] ... who is still active',
  $$ select t.mo('a_admin', t.a()) = 'Administrator/active/-' $$);
select t.distinguishable('[P2-1 c3] status: its three refusals (self, invited, last administrator) can be told apart', 'status', 3);
select t.did('[P2-1 c3] status: the deactivated Administrator is reactivated', 'service',
  t.set_status(t.a(), t.uid('a_super'), 'active', t.uid('a_admin')), 1);

-- ---------------------------------------------------------------------------
-- Criterion 3: saas_remove_member
-- ---------------------------------------------------------------------------
-- Org A has two active Administrators again: a_admin and a_super.

create table t.accounts_before as
  select u.id, to_jsonb(u) as row from auth.users u where u.id in (select t.uid(actor) from t.accounts);

select t.ok('[P2-1 c3] remove: for a member with no records the function returns ''removed''', 'service',
  format('select public.saas_remove_member(%L, %L, %L) = ''removed''', t.a(), t.uid('a_exadmin'), t.uid('a_admin')));
select t.mark_audit();
select t.did('[P2-1 c3] remove: done', 'service',
  t.remove(t.a(), t.uid('a_exadmin'), t.uid('a_admin')), 1);
select t.ok('[P2-1 c3] ... the membership row is gone',
  $$ select t.mo('a_exadmin', t.a()) = 'no membership' $$);
select t.audited('[P2-1 c3] ... one audit row', t.uid('a_admin'), t.a(), t.uid('a_exadmin'));

select t.ok('[P2-1 c3] remove: for a member with records the function returns ''deactivated''', 'service',
  format('select public.saas_remove_member(%L, %L, %L) = ''deactivated''', t.a(), t.uid('a_driller2'), t.uid('a_admin')));
select t.did('[P2-1 c3] remove: done', 'service',
  t.remove(t.a(), t.uid('a_driller2'), t.uid('a_admin')), 1);
select t.ok('[P2-1 c3] ... the membership is kept, deactivated, with its role and badge',
  $$ select t.mo('a_driller2', t.a()) = 'Data Logger/deactivated/D-2' $$);
select t.audited('[P2-1 c3] ... one audit row', t.uid('a_admin'), t.a(), t.uid('a_driller2'));
select t.ok('[P2-1 c3] ... and their records are all still there',
  $$ select (select count(*) from public.boreholes where created_by = t.uid('a_driller2')) = 1
        and (select count(*) from public.pipe_records where created_by = t.uid('a_driller2')) = 1 $$);

select t.ok('[P2-1 c3][P2-1 c7] remove: a member whose records are all soft-deleted is deactivated, not removed', 'service',
  format('select public.saas_remove_member(%L, %L, %L) = ''deactivated''', t.a(), t.uid('a_exsuper'), t.uid('a_admin')));

-- b_driller: invited to org A above, four records in org B, none in A.
select t.ok('[P2-1 c3][P2-1 c7] remove: records in ANOTHER organization do not keep a membership here: ''removed''', 'service',
  format('select public.saas_remove_member(%L, %L, %L) = ''removed''', t.a(), t.uid('b_driller'), t.uid('a_admin')));
select t.did('[P2-1 c3] remove: an invitation is removed', 'service',
  t.remove(t.a(), t.uid('b_driller'), t.uid('a_admin')), 1);
select t.ok('[P2-1 c12] ... gone from org A; their membership in org B and their records there are untouched',
  $$ select t.m('b_driller') = 'Driller/active/-' and t.mo('b_driller', t.b()) = 'Driller/active/-'
        and (select count(*) from public.boreholes where created_by = t.uid('b_driller') and org_id = t.b()) = 1 $$);

select t.refused('[P2-1 c3] remove: refused when member = actor (a Data Logger removing themselves; no other rule is involved)', 'service',
  t.remove(t.a(), t.uid('a_logger'), t.uid('a_logger')), 'remove', 'self');
select t.no_change('[P2-1 c12] remove: for a member of org B asked through org A, nothing changes anywhere', 'service',
  t.remove(t.a(), t.uid('b_super'), t.uid('a_admin')));
select t.no_change('[P2-1 c3] remove: for a user id that is no account, nothing changes', 'service',
  t.remove(t.a(), t.uid('no_such_account'), t.uid('a_admin')));

select t.ok('[P2-1 c3] remove: with two active Administrators, removing one (who has records) returns ''deactivated''', 'service',
  format('select public.saas_remove_member(%L, %L, %L) = ''deactivated''', t.a(), t.uid('a_super'), t.uid('a_admin')));
select t.did('[P2-1 c3] remove: done', 'service',
  t.remove(t.a(), t.uid('a_super'), t.uid('a_admin')), 1);
select t.refused('[P2-1 c3] remove: refused when it would remove the only active Administrator (asked by somebody else)', 'service',
  t.remove(t.a(), t.uid('a_admin'), t.uid('a_driller')), 'remove', 'last administrator');
select t.refused('[P2-1 c3][P2-1 c6] remove: the only Administrator of org B cannot be removed either, whoever asks', 'service',
  t.remove(t.b(), t.uid('b_admin'), t.uid('a_admin')), 'remove', null);
select t.ok('[P2-1 c3] ... both are still active Administrators of their organizations',
  $$ select t.mo('a_admin', t.a()) = 'Administrator/active/-' and t.mo('b_admin', t.b()) = 'Administrator/active/-' $$);
select t.distinguishable('[P2-1 c3] remove: its two refusals (self, last administrator) can be told apart', 'remove', 2);

select t.ok('[P2-1 c3][D2-5] the auth accounts were never touched: every account of the cast is exactly the row it was, the removed and deactivated ones included',
  $$ select count(*) = 16 and bool_and(to_jsonb(u) = b.row) from auth.users u join t.accounts_before b on b.id = u.id $$);
select t.ok('[P2-1 c10][D2-5] ... and nobody was banned',
  $$ select not exists (select 1 from auth.users where id in (select t.uid(actor) from t.accounts) and banned_until is not null) $$);

-- ---------------------------------------------------------------------------
-- Criteria 11 and 12: clients gained nothing
-- ---------------------------------------------------------------------------

select t.none(format('[P2-1 c11] the organization''s Administrator still cannot %s directly', what), 'a_admin', q)
from (values
  ('insert a membership',
   format('insert into public.memberships (org_id, user_id, role) values (%L, %L, ''Driller'')', t.a(), t.uid('b_super'))),
  ('change a membership',
   format('update public.memberships set role = ''Administrator'' where org_id = %L and user_id = %L', t.a(), t.uid('a_logger'))),
  ('delete a membership',
   format('delete from public.memberships where org_id = %L and user_id = %L', t.a(), t.uid('a_logger'))),
  ('create an organization',
   $$ insert into public.organizations (name) values ('Mine') $$),
  ('rename their organization',
   format('update public.organizations set name = ''Renamed'' where id = %L', t.a())),
  ('delete their organization',
   format('delete from public.organizations where id = %L', t.a())),
  ('write an audit row',
   format('insert into public.audit_log (actor_id, org_id, action) values (%L, %L, ''forged'')', t.uid('a_admin'), t.a())),
  ('change an audit row',
   format('update public.audit_log set action = ''edited'' where org_id = %L', t.a())),
  ('delete an audit row',
   format('delete from public.audit_log where org_id = %L', t.a()))) v(what, q);

select t.ok('[P2-1 c12] the Administrator of org A reads the audit rows the functions wrote for org A, and no row of another organization', 'a_admin',
  format($$ select count(*) >= 10 and bool_and(org_id = %L) from public.audit_log $$, t.a()));
select t.none('[P2-1 c12] the Administrator of org B reads none of them', 'b_admin',
  format('select id from public.audit_log where org_id = %L', t.a()));
select t.ok('[P2-1 c12] ... only the rows of org B', 'b_admin',
  format($$ select count(*) >= 1 and bool_and(org_id = %L) from public.audit_log $$, t.b()));
select t.none('[P2-1 c12] a plain member of org A reads no audit row', 'a_logger',
  $$ select id from public.audit_log $$);
select t.none('[P2-1 c12] the Administrator of org B reads no membership of org A, the ones the functions wrote included', 'b_admin',
  format('select user_id from public.memberships where org_id = %L', t.a()));
select t.none('[P2-1 c12] the member the functions added to org A reads nobody else''s membership', 'stranger',
  format('select user_id from public.memberships where user_id <> %L', t.uid('stranger')));

rollback;
select 'done';
