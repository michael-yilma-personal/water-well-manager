-- Criterion 8: the organization of a row is decided by triggers, not by the
-- client.
-- plan: 59
begin;
\ir ../lib/helpers.sql
\ir ../lib/fixture.sql

-- ---------------------------------------------------------------------------
-- A child row always takes org_id from its borehole
-- ---------------------------------------------------------------------------

select t.ok(format('[c8] %s: a row sent without org_id takes its borehole''s organization', tbl), 'a_driller',
  format('with i as (%s returning org_id) select org_id = %L from i',
         t.ins(tbl, t.rid(tbl, 'new'), t.rid('boreholes', 'a_driller'), t.uid('a_driller')), t.uid('org_a')))
from t.tables where is_child order by tbl;

select t.ok(format('[c8] %s: a row sent with its own organization''s org_id keeps its borehole''s organization', tbl), 'a_driller',
  format('with i as (%s returning org_id) select org_id = %L from i',
         t.ins(tbl, t.rid(tbl, 'new'), t.rid('boreholes', 'a_driller'), t.uid('a_driller'), t.uid('org_a')), t.uid('org_a')))
from t.tables where is_child order by tbl;

select t.ok(format('[c8] %s: a row sent with ANOTHER organization''s org_id still takes its borehole''s organization', tbl), 'a_driller',
  format('with i as (%s returning org_id) select org_id = %L from i',
         t.ins(tbl, t.rid(tbl, 'new'), t.rid('boreholes', 'a_driller'), t.uid('a_driller'), t.uid('org_b')), t.uid('org_a')))
from t.tables where is_child order by tbl;

-- "Whatever the client sent" includes a client that bypasses RLS.
select t.ok(format('[c8] %s: the rule holds for the service role too (wrong org_id sent, borehole''s organization stored)', tbl), 'service',
  format('with i as (%s returning org_id) select org_id = %L from i',
         t.ins(tbl, t.rid(tbl, 'new'), t.rid('boreholes', 'a_driller'), t.uid('a_driller'), t.uid('org_b')), t.uid('org_a')))
from t.tables where is_child order by tbl;

select t.ok(format('[c8] %s: a member of two organizations gets the borehole''s organization, in either', tbl), 'dual',
  format('with i as (%s returning org_id), j as (%s returning org_id) select (select org_id from i) = %L and (select org_id from j) = %L',
         t.ins(tbl, t.rid(tbl, 'new1'), t.rid('boreholes', 'dual_a'), t.uid('dual'), t.uid('org_b')),
         t.ins(tbl, t.rid(tbl, 'new2'), t.rid('boreholes', 'dual_b'), t.uid('dual'), t.uid('org_a')),
         t.uid('org_a'), t.uid('org_b')))
from t.tables where is_child order by tbl;

-- ---------------------------------------------------------------------------
-- A borehole sent without org_id
-- ---------------------------------------------------------------------------

select t.ok('[c8] borehole without org_id: an author with exactly one active membership gets that organization', 'a_driller',
  format('with i as (%s returning org_id) select org_id = %L from i',
         t.ins('boreholes', t.uid('new'), null, t.uid('a_driller')), t.uid('org_a')));
select t.ok('[c8] borehole without org_id: the same for a member of the other organization', 'b_driller',
  format('with i as (%s returning org_id) select org_id = %L from i',
         t.ins('boreholes', t.uid('new'), null, t.uid('b_driller')), t.uid('org_b')));
select t.ok('[c8] borehole without org_id: one active and one deactivated membership counts as exactly one (the active one)', 'mixed',
  format('with i as (%s returning org_id) select org_id = %L from i',
         t.ins('boreholes', t.uid('new'), null, t.uid('mixed')), t.uid('org_b')));
select t.throws('[c8] borehole without org_id: an author with two active memberships is rejected with 42501', 'dual',
  t.ins('boreholes', t.uid('new'), null, t.uid('dual')), '42501');
select t.throws('[c8] borehole without org_id: an author with no membership is rejected with 42501', 'stranger',
  t.ins('boreholes', t.uid('new'), null, t.uid('stranger')), '42501');
select t.throws('[c8] borehole without org_id: an author whose only membership is deactivated is rejected with 42501', 'a_gone',
  t.ins('boreholes', t.uid('new'), null, t.uid('a_gone')), '42501');
select t.throws('[c8] borehole without org_id: an author whose only membership is still "invited" is rejected with 42501', 'a_invited',
  t.ins('boreholes', t.uid('new'), null, t.uid('a_invited')), '42501');
select t.throws('[c8] borehole with an explicit null org_id is treated as sent without one (two memberships: 42501)', 'dual',
  format('insert into public.boreholes (id, name, created_by, recorded_at, org_id) values (%L, ''x'', %L, now(), null)',
         t.uid('new'), t.uid('dual')), '42501');

select t.ok('[c8] borehole with org_id: a member of two organizations chooses, and the choice is stored', 'dual',
  format('with i as (%s returning org_id), j as (%s returning org_id) select (select org_id from i) = %L and (select org_id from j) = %L',
         t.ins('boreholes', t.uid('new1'), null, t.uid('dual'), t.uid('org_a')),
         t.ins('boreholes', t.uid('new2'), null, t.uid('dual'), t.uid('org_b')),
         t.uid('org_a'), t.uid('org_b')));

-- ---------------------------------------------------------------------------
-- org_id never changes
-- ---------------------------------------------------------------------------

select t.throws(format('[c8] %s: the author cannot change org_id to another organization (42501)', tbl), 'a_driller',
  format('update public.%I set org_id = %L where id = %L', tbl, t.uid('org_b'), t.rid(tbl, 'a_driller')), '42501')
from t.tables order by tbl;
select t.throws(format('[c8] %s: a member of both organizations cannot move their row from one to the other (42501)', tbl), 'dual',
  format('update public.%I set org_id = %L where id = %L', tbl, t.uid('org_b'), t.rid(tbl, 'dual_a')), '42501')
from t.tables order by tbl;
select t.throws(format('[c8] %s: org_id cannot be set to null (42501)', tbl), 'a_driller',
  format('update public.%I set org_id = null where id = %L', tbl, t.rid(tbl, 'a_driller')), '42501')
from t.tables order by tbl;
select t.throws(format('[c8] %s: the service role cannot change org_id either (42501)', tbl), 'service',
  format('update public.%I set org_id = %L where id = %L', tbl, t.uid('org_b'), t.rid(tbl, 'a_driller')), '42501')
from t.tables order by tbl;
select t.rows(format('[c8] %s: an update that re-sends the same org_id is not a change and goes through', tbl), 'a_driller',
  format('update public.%I set org_id = %L, %I = ''same org'' where id = %L', tbl, t.uid('org_a'), col, t.rid(tbl, 'a_driller')), 1)
from t.tables order by tbl;
select t.rows(format('[c8] %s: an upsert that re-sends the row with its org_id goes through', tbl), 'a_driller',
  t.ins(tbl, t.rid(tbl, 'a_driller'), t.rid('boreholes', 'a_driller'), t.uid('a_driller'), t.uid('org_a'))
    || format(' on conflict (id) do update set org_id = excluded.org_id, %I = ''resent''', col), 1)
from t.tables order by tbl;
select t.throws(format('[c8] %s: an upsert cannot move an existing row to another organization (42501)', tbl), 'dual',
  t.ins(tbl, t.rid(tbl, 'dual_a'), t.rid('boreholes', 'dual_a'), t.uid('dual'), t.uid('org_a'))
    || format(' on conflict (id) do update set org_id = %L', t.uid('org_b')), '42501')
from t.tables order by tbl;

-- A child cannot leave its organization by being re-pointed at a borehole of
-- another one. Refused by the trigger (42501) or by a constraint (23503/23514).
select t.throws(format('[c8][c12] %s: the author cannot re-point their row at another organization''s borehole', tbl), 'dual',
  format('update public.%I set borehole_id = %L where id = %L', tbl, t.rid('boreholes', 'dual_b'), t.rid(tbl, 'dual_a')),
  '42501', '23503', '23514')
from t.tables where is_child order by tbl;
select t.ok(format('[c8][c12] %s: no row sits on a borehole of a different organization', tbl),
  format('select not exists (select 1 from public.%I c join public.boreholes b on b.id = c.borehole_id where c.org_id is distinct from b.org_id)', tbl))
from t.tables where is_child order by tbl;

rollback;
select 'done';
