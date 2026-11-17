-- Criteria 10 and 12 for the four record tables: who reads and writes what
-- inside an organization, and the cross-organization matrix: every table,
-- every verb, by listing, by id, by a forged org_id, by attaching a child to
-- the other organization's borehole, by upsert.
-- plan: 866
begin;
\ir ../lib/helpers.sql
\ir ../lib/fixture.sql

-- ---------------------------------------------------------------------------
-- Listing: how many rows each actor gets back (criterion 10 SELECT)
-- ---------------------------------------------------------------------------

select case when s.n > 0
  then t.rows(format('[c10] %s: %s lists exactly %s row(s) across both organizations', tbl, s.actor, s.n), s.actor,
              format('select id from public.%I where org_id in (%L, %L)', tbl, t.uid('org_a'), t.uid('org_b')), s.n)
  else t.none(format('[c10][c12] %s: %s lists nothing', tbl, s.actor), s.actor,
              format('select id from public.%I', tbl))
  end
from t.sees s cross join t.tables
order by tbl, s.actor;

select t.rows(format('[c10] %s: a member of both organizations sees %s row(s) under %s', tbl, n, org), 'dual',
  format('select id from public.%I where org_id = %L', tbl, t.uid(org)), n)
from t.tables cross join (values ('org_a', 1), ('org_b', 3)) v(org, n)
order by tbl, org;

-- ---------------------------------------------------------------------------
-- The cross-organization matrix (criterion 12)
-- ---------------------------------------------------------------------------
-- o.actor has no active membership in o.org. The target is the set o.victim.

create view t.x as
  select o.actor, o.own, o.org, tb.tbl, tb.col, tb.is_child,
         t.uid(o.actor) as me, t.uid(o.org) as org_id, t.uid(o.own) as own_id,
         t.rid(tb.tbl, o.victim) as vid, t.rid('boreholes', o.victim) as vbh,
         t.uid((select author from t.sets where tag = o.victim)) as vauthor,
         format('%s: %s against %s', tb.tbl, o.actor, o.org) as who
  from t.outsiders o cross join t.tables tb;
grant select on t.x to public;

select t.none(format('[c12] %s: cannot list its rows', who), actor,
  format('select id from public.%I where org_id = %L', tbl, org_id))
from t.x order by tbl, actor, org;

select t.none(format('[c12] %s: cannot read a row by id', who), actor,
  format('select * from public.%I where id = %L', tbl, vid))
from t.x order by tbl, actor, org;

select t.none(format('[c12] %s: cannot change a row by id', who), actor,
  format('update public.%I set %I = ''hijacked'' where id = %L', tbl, col, vid))
from t.x order by tbl, actor, org;

select t.none(format('[c12] %s: cannot soft-delete a row by id', who), actor,
  format('update public.%I set deleted_at = now() where id = %L', tbl, vid))
from t.x order by tbl, actor, org;

select t.none(format('[c12] %s: cannot delete a row by id', who), actor,
  format('delete from public.%I where id = %L', tbl, vid))
from t.x order by tbl, actor, org;

select t.none(format('[c12] %s: cannot pull a row into their own organization', who), actor,
  format('update public.%I set org_id = %L where id = %L', tbl, own_id, vid))
from t.x where own is not null order by tbl, actor, org;

select t.throws(format('[c12] %s: cannot create a row by sending its org_id', who), actor,
  t.ins(tbl, t.uid('new'), vbh, me, org_id), '42501')
from t.x order by tbl, actor, org;

select t.throws(format('[c12] %s: cannot attach a row to its borehole (no org_id sent)', who), actor,
  t.ins(tbl, t.uid('new'), vbh, me), '42501')
from t.x where is_child order by tbl, actor, org;

select t.throws(format('[c12] %s: cannot attach a row to its borehole while claiming their own org_id', who), actor,
  t.ins(tbl, t.uid('new'), vbh, me, own_id), '42501')
from t.x where is_child and own is not null order by tbl, actor, org;

select t.throws(format('[c12] %s: with no active membership, cannot create a borehole at all (no org_id sent)', who), actor,
  t.ins(tbl, t.uid('new'), null, me), '42501')
from t.x where not is_child and own is null order by tbl, actor, org;

select t.throws(format('[c12] %s: cannot overwrite a row by upserting its id', who), actor,
  t.ins(tbl, vid, vbh, me) || format(' on conflict (id) do update set %I = ''hijacked''', col), '42501')
from t.x order by tbl, actor, org;

select t.throws(format('[c12] %s: cannot overwrite a row by replaying it under its author''s id and org_id', who), actor,
  t.ins(tbl, vid, vbh, vauthor, org_id) || format(' on conflict (id) do update set %I = ''hijacked''', col), '42501')
from t.x where me is distinct from vauthor order by tbl, actor, org;

-- A reviewer's reach stops at the organization: the one cross-author write
-- that exists (correcting a pipe record) does not cross it.
select t.none(format('[c12] pipe_records: %s cannot correct the formation of a pipe record of %s', actor, org), actor,
  format('update public.pipe_records set formation = ''Basalt'' where id = %L', t.rid('pipe_records', victim)))
from t.outsiders where actor in ('a_super', 'a_admin', 'b_super', 'b_admin', 'a_exsuper', 'a_exadmin', 'a_invited', 'mixed')
order by actor, org;

-- The member of both: Supervisor of B, only a Driller in A.
select t.rows(format('[c10] %s: a Supervisor of B who is a Driller in A reads a B colleague''s row', tbl), 'dual',
  format('select id from public.%I where id = %L', tbl, t.rid(tbl, 'b_driller')), 1)
from t.tables order by tbl;
select t.none(format('[c12] %s: ... but not an A colleague''s row', tbl), 'dual',
  format('select id from public.%I where id = %L', tbl, t.rid(tbl, 'a_driller')))
from t.tables order by tbl;
select t.rows('[c10] pipe_records: ... corrects a B colleague''s pipe record', 'dual',
  format('update public.pipe_records set formation = ''Basalt'' where id = %L', t.rid('pipe_records', 'b_driller')), 1);
select t.none('[c12] pipe_records: ... but not an A colleague''s', 'dual',
  format('update public.pipe_records set formation = ''Basalt'' where id = %L', t.rid('pipe_records', 'a_driller')));

-- ---------------------------------------------------------------------------
-- Inside one organization (criterion 10): each role still does what it could
-- ---------------------------------------------------------------------------

-- Authors.
select t.rows(format('[c10] %s: %s reads their own row', tbl, a), a,
  format('select id from public.%I where id = %L', tbl, t.rid(tbl, a)), 1)
from t.tables cross join (values ('a_driller'), ('a_logger'), ('a_super'), ('b_driller')) v(a) order by tbl, a;
select t.rows(format('[c10] %s: %s changes their own row', tbl, a), a,
  format('update public.%I set %I = ''changed'' where id = %L', tbl, col, t.rid(tbl, a)), 1)
from t.tables cross join (values ('a_driller'), ('a_logger'), ('a_super'), ('b_driller')) v(a) order by tbl, a;
select t.rows(format('[c10] %s: %s soft-deletes their own row', tbl, a), a,
  format('update public.%I set deleted_at = now() where id = %L', tbl, t.rid(tbl, a)), 1)
from t.tables cross join (values ('a_driller'), ('a_logger'), ('a_super'), ('b_driller')) v(a) order by tbl, a;
select t.ok(format('[c10] %s: %s (%s) creates a row without sending org_id, and it lands in their organization', tbl, a, r), a,
  format('with i as (%s returning org_id) select org_id = %L from i',
         t.ins(tbl, t.uid('new'), t.rid('boreholes', a), t.uid(a)), t.uid(org)))
from t.tables cross join (values
  ('a_driller', 'Driller', 'org_a'), ('a_logger', 'Data Logger', 'org_a'),
  ('a_super', 'Supervisor', 'org_a'), ('b_driller', 'Driller', 'org_b')) v(a, r, org)
order by tbl, a;
select t.rows(format('[c10] %s: %s (%s) creates a row sending their organization''s org_id', tbl, a, r), a,
  t.ins(tbl, t.uid('new'), t.rid('boreholes', a), t.uid(a), t.uid(org)), 1)
from t.tables cross join (values
  ('a_driller', 'Driller', 'org_a'), ('a_logger', 'Data Logger', 'org_a'),
  ('a_super', 'Supervisor', 'org_a'), ('b_driller', 'Driller', 'org_b')) v(a, r, org)
order by tbl, a;
select t.throws(format('[c10] %s: nobody creates a row in another member''s name (created_by must be the caller)', tbl), 'a_driller',
  t.ins(tbl, t.uid('new'), t.rid('boreholes', 'a_driller'), t.uid('a_driller2'), t.uid('org_a')), '42501')
from t.tables order by tbl;
select t.throws(format('[c10] %s: no DELETE, even of one''s own row (%s)', tbl, a), a,
  format('delete from public.%I where id = %L', tbl, t.rid(tbl, a)), '42501')
from t.tables cross join (values ('a_driller'), ('a_super'), ('a_admin')) v(a) order by tbl, a;

-- A Driller and a colleague in the same organization.
select t.none(format('[c10] %s: a Driller cannot read a colleague''s row', tbl), 'a_driller',
  format('select id from public.%I where id = %L', tbl, t.rid(tbl, 'a_driller2')))
from t.tables order by tbl;
select t.none(format('[c10] %s: a Driller cannot change a colleague''s row', tbl), 'a_driller',
  format('update public.%I set %I = ''hijacked'' where id = %L', tbl, col, t.rid(tbl, 'a_driller2')))
from t.tables order by tbl;
select t.throws(format('[c10] %s: a Driller cannot overwrite a colleague''s row by upserting its id', tbl), 'a_driller',
  t.ins(tbl, t.rid(tbl, 'a_driller2'), t.rid('boreholes', 'a_driller2'), t.uid('a_driller'))
    || format(' on conflict (id) do update set %I = ''hijacked''', col), '42501')
from t.tables order by tbl;

-- Reviewers.
select t.rows(format('[c10] %s: %s reads a crew member''s row', tbl, a), a,
  format('select id from public.%I where id = %L', tbl, t.rid(tbl, 'a_driller')), 1)
from t.tables cross join (values ('a_super'), ('a_admin')) v(a) order by tbl, a;
select t.rows(format('[c10] %s: %s still reads the rows of a member who was deactivated', tbl, a), a,
  format('select id from public.%I where id = %L', tbl, t.rid(tbl, 'a_gone')), 1)
from t.tables cross join (values ('a_super'), ('a_admin')) v(a) order by tbl, a;
select t.none(format('[c10] %s: %s cannot change a crew member''s row (only the author can)', tbl, a), a,
  format('update public.%I set %I = ''changed'' where id = %L', tbl, col, t.rid(tbl, 'a_driller')))
from t.tables cross join (values ('a_super'), ('a_admin')) v(a) where tbl <> 'pipe_records' order by tbl, a;
select t.ok(format('[c10] pipe_records: %s corrects the formation of a crew member''s pipe record and is stamped as editor', a), a,
  format('with u as (update public.pipe_records set formation = ''Basalt'' where id = %L returning edited_by) select edited_by = %L from u',
         t.rid('pipe_records', 'a_driller'), t.uid(a)))
from (values ('a_super'), ('a_admin')) v(a);
select t.throws(format('[c10] pipe_records: %s cannot %s a crew member''s pipe record (column guard)', a, what), a,
  format('update public.pipe_records set %s where id = %L', setc, t.rid('pipe_records', 'a_driller')), '42501')
from (values ('a_super'), ('a_admin')) v(a)
cross join (values
  ('change the depth of',  'end_depth = 99'),
  ('soft-delete',          'deleted_at = now()'),
  ('change the author of', format('created_by = %L', t.uid('a_driller2'))),
  ('re-point',             format('borehole_id = %L', t.rid('boreholes', 'a_driller2')))) w(what, setc)
order by a, what;

-- Administrators read the record; they do not write it.
select t.throws(format('[c10] %s: an Administrator cannot create a row (%s)', tbl, how), 'a_admin',
  t.ins(tbl, t.uid('new'), t.rid('boreholes', 'a_admin'), t.uid('a_admin'), org), '42501')
from t.tables cross join (values ('no org_id sent', null::uuid), ('own org_id sent', t.uid('org_a'))) v(how, org)
order by tbl, how;
select t.none(format('[c10] %s: an Administrator cannot change a row they authored before becoming one', tbl), 'a_admin',
  format('update public.%I set %I = ''changed'' where id = %L', tbl, col, t.rid(tbl, 'a_admin')))
from t.tables where tbl <> 'pipe_records' order by tbl;

rollback;
select 'done';
