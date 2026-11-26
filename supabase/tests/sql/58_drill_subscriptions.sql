-- SaaS Phase 3, task P3-2: the subscription in Drill's record and photo
-- policies. Check names carry [P3-2 cN] for acceptance criterion N.
-- (Criteria 6 and 7 are the function's: src/admin/saasMembersHandler.test.ts.)
--
-- ASSUMED where the criteria leave the choice to the Developer:
--   * A record write the subscription refuses raises SQLSTATE SS002, for an
--     INSERT, for the upsert the field app sends and for a plain UPDATE (an
--     UPDATE that silently changes no row is not a refusal the app can see).
--   * A refused photo upload raises 42501 or SS002: criterion 4 names no code.
--   * Legacy-path photos belong to the founding organization (decision 30),
--     so its subscription decides for them.
--   * Not pinned: which of the two codes a write gets that the subscription
--     AND an ordinary rule would both refuse (a deactivated member of an
--     expired organization).
--
-- Organization A's subscription is set by the connecting role, state by
-- state; organization B stays active throughout.
-- plan: 40
begin;
\ir ../lib/helpers.sql
\ir ../lib/fixture.sql

create function t.a() returns uuid language sql immutable as $$ select t.uid('org_a') $$;
create function t.b() returns uuid language sql immutable as $$ select t.uid('org_b') $$;

-- The states of the section 8 table (grace_days is 7).
create table t.states (st text primary key, status text, ends interval);
insert into t.states values
  ('trial', 'trial', '1 day'), ('active', 'active', null), ('grace', 'active', '-3 days'),
  ('expired', 'active', '-8 days'), ('suspended', 'suspended', null), ('canceled', 'canceled', null);
create function t.state(s text, org uuid default t.a()) returns void
language sql as $$ select t.sub(org, status, now() + ends) from t.states where st = s $$;

-- The writes: a new borehole, the upsert the field app sends for an edited
-- pipe record, and a reviewer's correction from the dashboard.
create table t.w (k text primary key, what text, actor text, q text);
insert into t.w values
  ('new',  'a Driller uploads a new borehole', 'a_driller',
   t.ins('boreholes', t.uid('p32 hole'), null, t.uid('a_driller'), t.a())),
  ('edit', 'a Driller''s edited pipe record is upserted', 'a_driller',
   t.ins('pipe_records', t.rid('pipe_records', 'a_driller'), t.rid('boreholes', 'a_driller'), t.uid('a_driller'), t.a())
     || ' on conflict (id) do update set formation = ''Sand'''),
  ('fix',  'a Supervisor corrects a pipe record', 'a_super',
   format('update public.pipe_records set formation = ''Sand'' where id = %L', t.rid('pipe_records', 'a_driller')));

-- A photo of A's Driller, and a Driller of the founding organization (whose
-- photos the installed build stores on the legacy path).
create function t.path(variadic parts text[]) returns text language sql immutable as $$
  select string_agg(case when i < array_length(parts, 1) then t.uid(p)::text else p end, '/' order by i)
  from unnest(parts) with ordinality u(p, i) $$;
create function t.upload(actor text, path text) returns text language sql immutable as $$
  select format('insert into storage.objects (bucket_id, name, owner) values (''drilling-photos'', %L, %L)', path, t.uid(actor)) $$;
create function t.photo(path text) returns text language sql immutable as $$
  select format('select name from storage.objects where bucket_id = ''drilling-photos'' and name = %L', path) $$;

create table t.founding as select id from public.organizations where is_founding;
insert into storage.objects (bucket_id, name, owner)
  values ('drilling-photos', t.path('org_a', 'a_driller', 'p.jpg'), t.uid('a_driller'));
insert into auth.users (id, email) values (t.uid('f_driller'), 'f_driller@db-test.invalid');
delete from public.memberships where user_id = t.uid('f_driller');
insert into public.memberships (org_id, user_id, role, status) select id, t.uid('f_driller'), 'Driller', 'active' from t.founding;

-- ---------------------------------------------------------------------------
-- Full access: trial, active, within grace (criterion 1)
-- ---------------------------------------------------------------------------

select t.rows(format('[P3-2 c1] active: %s', what), actor, q, 1) from t.w order by k;
select t.rows('[P3-2 c4][c10] active: a founding member uploads a photo on the legacy path', 'f_driller',
  t.upload('f_driller', t.path('f_driller', 'n.jpg')), 1);

select t.state('trial');
select t.rows('[P3-2 c1] trial, before its end date: ' || what, actor, q, 1) from t.w where k = 'new';

select t.state('grace');
select t.rows('[P3-2 c1] past the end date, within grace: ' || what, actor, q, 1) from t.w order by k;
select t.rows('[P3-2 c4] past the end date, within grace: a member uploads a photo', 'a_driller',
  t.upload('a_driller', t.path('org_a', 'a_driller', 'n.jpg')), 1);

-- ---------------------------------------------------------------------------
-- Expired: read only (criteria 1 to 5), and renewal (criterion 8)
-- ---------------------------------------------------------------------------

select t.state('expired');
select t.throws(format('[P3-2 c1][c2] expired: a Driller''s new row of %s is refused with SS002', tbl), 'a_driller',
  t.ins(tbl, t.uid('p32 ' || tbl), t.rid('boreholes', 'a_driller'), t.uid('a_driller'), t.a()), 'SS002')
from t.tables order by tbl;
select t.throws(format('[P3-2 c1][c2] expired: %s: refused with SS002', what), actor, q, 'SS002') from t.w where k <> 'new' order by k;
select t.throws('[P3-2 c2] expired: a write into ANOTHER organization, which has full access, is still an ordinary 42501', 'a_driller',
  t.ins('boreholes', t.uid('p32 forged'), null, t.uid('a_driller'), t.b()), '42501');

select t.rows('[P3-2 c3] expired: a Driller still reads their own borehole', 'a_driller',
  format('select id from public.boreholes where id = %L', t.rid('boreholes', 'a_driller')), 1);
select t.rows('[P3-2 c3] expired: a Supervisor still reads the organization''s seven pipe records', 'a_super',
  format('select id from public.pipe_records where org_id = %L', t.a()), 7);
select t.rows('[P3-2 c4] expired: a member still reads their photo', 'a_driller', t.photo(t.path('org_a', 'a_driller', 'p.jpg')), 1);
select t.throws('[P3-2 c4] expired: a photo upload is refused', 'a_driller',
  t.upload('a_driller', t.path('org_a', 'a_driller', 'n.jpg')), '42501', 'SS002');
select t.ok('[P3-2 c5] expired: my_organizations() lists the organization with access read_only', 'a_driller',
  format($$ select count(*) = 1 from public.my_organizations() where org_id = %L and access = 'read_only' $$, t.a()));

select t.state('active');
select t.rows(format('[P3-2 c8] renewed: the write refused during the lapse is accepted unchanged (%s)', what), actor, q, 1) from t.w order by k;

select t.state('expired', (select id from t.founding));
select t.throws('[P3-2 c4] founding organization expired: a photo upload on the legacy path is refused', 'f_driller',
  t.upload('f_driller', t.path('f_driller', 'n.jpg')), '42501', 'SS002');
select t.state('active', (select id from t.founding));

-- ---------------------------------------------------------------------------
-- Suspended and canceled: nothing but signing in (criteria 2 to 5, 9)
-- ---------------------------------------------------------------------------

select t.state('suspended');
select t.throws(format('[P3-2 c2] suspended: %s: refused with SS002', what), actor, q, 'SS002') from t.w where k = 'new';
select t.none(format('[P3-2 c3] suspended: a Supervisor reads no row of %s', tbl), 'a_super',
  format('select id from public.%I where org_id = %L', tbl, t.a()))
from t.tables order by tbl;
select t.none('[P3-2 c4] suspended: the Administrator reads no photo', 'a_admin', t.photo(t.path('org_a', 'a_driller', 'p.jpg')));
select t.throws('[P3-2 c4] suspended: a photo upload is refused', 'a_driller',
  t.upload('a_driller', t.path('org_a', 'a_driller', 'n.jpg')), '42501', 'SS002');
select t.ok('[P3-2 c5] suspended: my_organizations() still lists the organization, with access none', 'a_driller',
  format($$ select count(*) = 1 from public.my_organizations() where org_id = %L and access = 'none' $$, t.a()));
select t.rows('[P3-2 c5] suspended: a member still reads their own profile', 'a_driller',
  format('select id from public.profiles where id = %L', t.uid('a_driller')), 1);

select t.rows('[P3-2 c9] A suspended: a Driller of B uploads a new borehole to B', 'b_driller',
  t.ins('boreholes', t.uid('p32 b hole'), null, t.uid('b_driller'), t.b()), 1);
select t.rows('[P3-2 c9] A suspended: a Supervisor of B reads B''s three boreholes', 'b_super',
  'select id from public.boreholes', 3);
select t.ok('[P3-2 c9] A suspended: a Driller of A who is a Supervisor of B reads B''s three boreholes and none of A''s', 'dual',
  format('select count(*) = 3 and bool_and(org_id = %L) from public.boreholes', t.b()));

select t.state('canceled');
select t.throws(format('[P3-2 c2] canceled: %s: refused with SS002', what), actor, q, 'SS002') from t.w where k = 'new';
select t.none('[P3-2 c3] canceled: a Driller reads none of their own boreholes', 'a_driller',
  format('select id from public.boreholes where org_id = %L', t.a()));

rollback;
select 'done';
