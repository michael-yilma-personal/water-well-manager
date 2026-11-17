-- Two organizations with a full cast, created by the connecting role inside
-- the test transaction. Requires lib/helpers.sql.
--
--   Org A: a_driller, a_driller2 (Driller), a_logger (Data Logger),
--          a_super (Supervisor), a_admin (Administrator),
--          a_gone (Driller, deactivated), a_exsuper (Supervisor, deactivated),
--          a_exadmin (Administrator, deactivated), a_invited (Supervisor, invited)
--   Org B: b_driller, b_super, b_admin
--   dual:  Driller in A and Supervisor in B. Their legacy profiles.role says
--          Administrator, which must give them nothing.
--   mixed: deactivated Administrator in A, active Driller in B
--   stranger: an account with no membership whose legacy profiles.role says
--          Administrator
--   padmin: platform administrator with no membership
--
-- Every membership here is explicit. A new account may be enrolled in the
-- founding organization automatically (criterion 9, decision 27); whatever
-- the accounts were given on creation is removed before theirs are inserted,
-- so nobody in this cast belongs to the founding organization.

insert into t.blockers values ('the two-organization fixture');

create table t.members (actor text, org text, role text, status text, primary key (actor, org));
insert into t.members values
  ('a_driller',  'org_a', 'Driller',       'active'),
  ('a_driller2', 'org_a', 'Driller',       'active'),
  ('a_logger',   'org_a', 'Data Logger',   'active'),
  ('a_super',    'org_a', 'Supervisor',    'active'),
  ('a_admin',    'org_a', 'Administrator', 'active'),
  ('a_gone',     'org_a', 'Driller',       'deactivated'),
  ('a_exsuper',  'org_a', 'Supervisor',    'deactivated'),
  ('a_exadmin',  'org_a', 'Administrator', 'deactivated'),
  ('a_invited',  'org_a', 'Supervisor',    'invited'),
  ('b_driller',  'org_b', 'Driller',       'active'),
  ('b_super',    'org_b', 'Supervisor',    'active'),
  ('b_admin',    'org_b', 'Administrator', 'active'),
  ('dual',       'org_a', 'Driller',       'active'),
  ('dual',       'org_b', 'Supervisor',    'active'),
  ('mixed',      'org_a', 'Administrator', 'deactivated'),
  ('mixed',      'org_b', 'Driller',       'active');

create table t.accounts (actor text primary key);
insert into t.accounts
  select distinct actor from t.members
  union select 'stranger' union select 'padmin';

-- One borehole with one pipe record, one event and one shift log per tag.
-- Seven sets in A, three in B.
create table t.sets (tag text primary key, author text, org text);
insert into t.sets values
  ('a_driller',  'a_driller',  'org_a'),
  ('a_driller2', 'a_driller2', 'org_a'),
  ('a_logger',   'a_logger',   'org_a'),
  ('a_super',    'a_super',    'org_a'),
  ('a_admin',    'a_admin',    'org_a'),   -- authored before being made Administrator
  ('a_gone',     'a_gone',     'org_a'),   -- authored before being deactivated
  ('dual_a',     'dual',       'org_a'),
  ('b_driller',  'b_driller',  'org_b'),
  ('b_super',    'b_super',    'org_b'),
  ('dual_b',     'dual',       'org_b');

-- How many rows of each record table (within A and B) each actor may read:
-- an active member reads their own; a Supervisor or Administrator reads the
-- whole organization; everyone else reads nothing. Written out by hand from
-- criterion 10, not computed.
create table t.sees (actor text primary key, n int not null);
insert into t.sees values
  ('a_driller', 1), ('a_driller2', 1), ('a_logger', 1),
  ('a_super', 7), ('a_admin', 7),
  ('a_gone', 0), ('a_exsuper', 0), ('a_exadmin', 0), ('a_invited', 0),
  ('b_driller', 1), ('b_super', 3), ('b_admin', 3),
  ('dual', 4),        -- own set in A, all three in B
  ('mixed', 0),       -- Driller in B with no rows; nothing left of A
  ('stranger', 0), ('padmin', 0), ('anon', 0);

-- Who attacks which organization. `own` is the organization the attacker is an
-- active member of (null: none); `victim` is the tag of a set in `org`.
create table t.outsiders (actor text, own text, org text, victim text, primary key (actor, org));
insert into t.outsiders values
  ('a_driller', 'org_a', 'org_b', 'b_driller'),
  ('a_logger',  'org_a', 'org_b', 'b_driller'),
  ('a_super',   'org_a', 'org_b', 'b_driller'),
  ('a_admin',   'org_a', 'org_b', 'b_driller'),
  ('b_driller', 'org_b', 'org_a', 'a_driller'),
  ('b_super',   'org_b', 'org_a', 'a_driller'),
  ('b_admin',   'org_b', 'org_a', 'a_driller'),
  ('mixed',     'org_b', 'org_a', 'a_driller'),   -- was Administrator of A
  ('a_gone',    null,    'org_a', 'a_gone'),      -- their own old rows
  ('a_gone',    null,    'org_b', 'b_driller'),
  ('a_exsuper', null,    'org_a', 'a_driller'),
  ('a_exadmin', null,    'org_a', 'a_driller'),
  ('a_invited', null,    'org_a', 'a_driller'),
  ('stranger',  null,    'org_a', 'a_driller'),
  ('padmin',    null,    'org_a', 'a_driller'),
  ('anon',      null,    'org_a', 'a_driller');

grant select on all tables in schema t to public;

do $fx$
declare
  s record;
  c record;
begin
  insert into public.organizations (id, name) values
    (t.uid('org_a'), 'Org A'),
    (t.uid('org_b'), 'Org B');

  insert into auth.users (id, email)
    select t.uid(actor), actor || '@db-test.invalid' from t.accounts;

  -- Legacy profiles.role, set before the cast's memberships exist so nothing
  -- is mirrored into them. Single-organization accounts carry the role they hold there, as
  -- every real account does today, so a policy still trusting profiles.role
  -- (is_admin(), is_reviewer()) shows up as a cross-organization leak. The
  -- three below say Administrator and must get nothing from it.
  update public.profiles p set role = m.role
    from t.members m
    where p.id = t.uid(m.actor)
      and (select count(*) from t.members x where x.actor = m.actor) = 1;
  update public.profiles set role = 'Administrator'
    where id in (t.uid('stranger'), t.uid('dual'), t.uid('mixed'));

  delete from public.memberships where user_id in (select t.uid(actor) from t.accounts);

  insert into public.memberships (org_id, user_id, role, status)
    select t.uid(org), t.uid(actor), role, status from t.members;

  insert into public.platform_admins (user_id) values (t.uid('padmin'));

  for s in select * from t.sets order by tag loop
    execute t.ins('boreholes', t.rid('boreholes', s.tag), null, t.uid(s.author), t.uid(s.org));
    for c in select tbl from t.tables where is_child order by tbl loop
      execute t.ins(c.tbl, t.rid(c.tbl, s.tag), t.rid('boreholes', s.tag), t.uid(s.author), t.uid(s.org));
    end loop;
  end loop;

  insert into public.audit_log (actor_id, org_id, action) values
    (t.uid('a_admin'), t.uid('org_a'), 'test.a'),
    (t.uid('b_admin'), t.uid('org_b'), 'test.b'),
    (t.uid('padmin'),  null,           'test.platform');
end
$fx$;

-- The fixture itself must be what the tests assume, or their results mean
-- nothing: the blocker goes only when every piece is there.
delete from t.blockers
where what = 'the two-organization fixture'
  and (select count(*) from public.organizations where id in (t.uid('org_a'), t.uid('org_b'))) = 2
  and (select count(*) from public.memberships where org_id in (t.uid('org_a'), t.uid('org_b'))) = 16
  and (select count(*) from public.memberships where user_id in (select t.uid(actor) from t.accounts)) = 16
  and (select count(*) from public.profiles where id in (select t.uid(actor) from t.accounts)) = 16
  and (select count(*) from public.platform_admins where user_id = t.uid('padmin')) = 1
  and (select count(*) from public.boreholes       where org_id in (t.uid('org_a'), t.uid('org_b'))) = 10
  and (select count(*) from public.pipe_records    where org_id in (t.uid('org_a'), t.uid('org_b'))) = 10
  and (select count(*) from public.drilling_events where org_id in (t.uid('org_a'), t.uid('org_b'))) = 10
  and (select count(*) from public.shift_logs      where org_id in (t.uid('org_a'), t.uid('org_b'))) = 10
  and (select count(*) from public.audit_log where action like 'test.%') = 3;

select t.ok('[fixture] two organizations, 16 explicit memberships and no others, 16 accounts, 10 rows in each record table',
  $$ select true $$);
