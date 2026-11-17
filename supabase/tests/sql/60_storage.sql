-- Criterion 11 (photo policies for both path forms) and the "by path" cases of
-- criterion 12.
--   new     <org_id>/<user_id>/<file>
--   legacy  <user_id>/<file>          (the only form an installed build knows)
-- plan: 158
begin;
\ir ../lib/helpers.sql
\ir ../lib/fixture.sql

-- A path from labels: t.p('org_a', 'a_driller', 'p.jpg') or t.p('a_driller', 'old.jpg').
create function t.p(variadic parts text[]) returns text
language sql immutable
as $$
  select string_agg(case when i < array_length(parts, 1) then t.uid(p)::text else p end, '/' order by i)
  from unnest(parts) with ordinality u(p, i)
$$;

insert into t.blockers values ('the photo fixture');

create table t.photos (path text primary key, owner text);
insert into t.photos values
  (t.p('org_a', 'a_driller', 'p.jpg'), 'a_driller'),
  (t.p('org_a', 'a_gone',    'p.jpg'), 'a_gone'),
  (t.p('org_a', 'dual',      'p.jpg'), 'dual'),
  (t.p('org_b', 'dual',      'p.jpg'), 'dual'),
  (t.p('org_b', 'b_driller', 'p.jpg'), 'b_driller'),
  (t.p('a_driller', 'old.jpg'),        'a_driller'),
  (t.p('b_driller', 'old.jpg'),        'b_driller'),
  (t.p('dual',      'old.jpg'),        'dual'),
  (t.p('stranger',  'old.jpg'),        'stranger'),
  (t.p('a_gone',    'old.jpg'),        'a_gone'),
  -- Paths that are neither form.
  ('misc/x.jpg',                                   null),
  ('x.jpg',                                        null),
  (t.uid('org_a') || '/not-a-uuid/x.jpg',          null),
  (t.uid('org_a') || '/x.jpg',                     null),
  (t.uid('nobody') || '/x.jpg',                    null),
  (t.uid('nobody') || '/' || t.uid('a_driller') || '/x.jpg', null);
grant select on t.photos to public;

insert into storage.buckets (id, name, public) values ('db-test-other', 'db-test-other', false);
insert into storage.objects (bucket_id, name, owner)
  select 'drilling-photos', path, t.uid(owner) from t.photos;
insert into storage.objects (bucket_id, name, owner)
  values ('db-test-other', t.p('a_driller', 'x.jpg'), t.uid('a_driller'));

delete from t.blockers
where what = 'the photo fixture'
  and (select count(*) from storage.objects where bucket_id = 'drilling-photos' and name in (select path from t.photos)) = 16
  and (select count(*) from storage.objects where bucket_id = 'db-test-other') = 1;

select t.ok('[fixture] 16 photos are stored in drilling-photos and one in another bucket', $$ select true $$);

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------

create table t.read_cases (actor text, path text, yes boolean, why text);
insert into t.read_cases values
  -- new path, organization A
  ('a_driller',  t.p('org_a', 'a_driller', 'p.jpg'), true,  'new path: the author'),
  ('a_admin',    t.p('org_a', 'a_driller', 'p.jpg'), true,  'new path: Administrator of that organization'),
  ('a_admin',    t.p('org_a', 'a_gone', 'p.jpg'),    true,  'new path: Administrator, author since deactivated'),
  ('a_admin',    t.p('org_a', 'dual', 'p.jpg'),      true,  'new path: Administrator of A, author also in B'),
  ('b_admin',    t.p('org_b', 'dual', 'p.jpg'),      true,  'new path: Administrator of B, author also in A'),
  ('dual',       t.p('org_a', 'dual', 'p.jpg'),      true,  'new path: the author, first organization'),
  ('dual',       t.p('org_b', 'dual', 'p.jpg'),      true,  'new path: the author, second organization'),
  ('b_driller',  t.p('org_b', 'b_driller', 'p.jpg'), true,  'new path: the author'),
  ('b_admin',    t.p('org_b', 'b_driller', 'p.jpg'), true,  'new path: Administrator of that organization'),
  -- Criterion 18: a deactivated member reads no photo, their own included.
  ('a_gone',     t.p('org_a', 'a_gone', 'p.jpg'),    false, 'c18 new path: the author, since deactivated'),
  ('a_gone',     t.p('a_gone', 'old.jpg'),           false, 'c18 legacy path: the owner, since deactivated'),
  ('a_super',    t.p('org_a', 'a_driller', 'p.jpg'), false, 'new path: a Supervisor (Administrators only, as today)'),
  ('a_driller2', t.p('org_a', 'a_driller', 'p.jpg'), false, 'new path: a colleague'),
  ('a_logger',   t.p('org_a', 'a_driller', 'p.jpg'), false, 'new path: a colleague'),
  ('dual',       t.p('org_a', 'a_driller', 'p.jpg'), false, 'new path: a Driller of A whose legacy profile says Administrator'),
  ('b_admin',    t.p('org_a', 'a_driller', 'p.jpg'), false, 'new path: Administrator of another organization'),
  ('b_super',    t.p('org_a', 'a_driller', 'p.jpg'), false, 'new path: Supervisor of another organization'),
  ('b_driller',  t.p('org_a', 'a_driller', 'p.jpg'), false, 'new path: member of another organization'),
  ('b_admin',    t.p('org_a', 'dual', 'p.jpg'),      false, 'new path: A''s photo by a user B''s Administrator shares with A'),
  ('a_admin',    t.p('org_b', 'dual', 'p.jpg'),      false, 'new path: B''s photo by a user A''s Administrator shares with B'),
  ('a_admin',    t.p('org_b', 'b_driller', 'p.jpg'), false, 'new path: Administrator of another organization'),
  ('a_driller',  t.p('org_b', 'b_driller', 'p.jpg'), false, 'new path: member of another organization'),
  ('dual',       t.p('org_b', 'b_driller', 'p.jpg'), false, 'new path: a Supervisor of B whose legacy profile says Administrator'),
  ('a_exadmin',  t.p('org_a', 'a_driller', 'p.jpg'), false, 'new path: a deactivated Administrator'),
  ('mixed',      t.p('org_a', 'a_driller', 'p.jpg'), false, 'new path: a deactivated Administrator active elsewhere'),
  ('a_invited',  t.p('org_a', 'a_driller', 'p.jpg'), false, 'new path: an invited member'),
  ('stranger',   t.p('org_a', 'a_driller', 'p.jpg'), false, 'new path: legacy profiles.role Administrator, no membership'),
  ('padmin',     t.p('org_a', 'a_driller', 'p.jpg'), false, 'new path: a platform administrator'),
  ('anon',       t.p('org_a', 'a_driller', 'p.jpg'), false, 'new path: signed out'),
  -- legacy path
  ('a_driller',  t.p('a_driller', 'old.jpg'), true,  'legacy path: the owner'),
  ('a_admin',    t.p('a_driller', 'old.jpg'), true,  'legacy path: an Administrator who shares an organization with the owner'),
  ('b_driller',  t.p('b_driller', 'old.jpg'), true,  'legacy path: the owner'),
  ('b_admin',    t.p('b_driller', 'old.jpg'), true,  'legacy path: an Administrator who shares an organization with the owner'),
  ('dual',       t.p('dual', 'old.jpg'),      true,  'legacy path: the owner'),
  ('a_admin',    t.p('dual', 'old.jpg'),      true,  'legacy path: Administrator of A, which the owner belongs to'),
  ('b_admin',    t.p('dual', 'old.jpg'),      true,  'legacy path: Administrator of B, which the owner belongs to'),
  ('stranger',   t.p('stranger', 'old.jpg'),  true,  'legacy path: the owner'),
  ('a_admin',    t.p('a_gone', 'old.jpg'),    true,  'legacy path: Administrator; the owner is a deactivated member of their organization'),
  ('b_admin',    t.p('a_gone', 'old.jpg'),    false, 'legacy path: Administrator of another organization; the owner is deactivated'),
  ('a_super',    t.p('a_driller', 'old.jpg'), false, 'legacy path: a Supervisor'),
  ('a_driller2', t.p('a_driller', 'old.jpg'), false, 'legacy path: a colleague'),
  ('b_admin',    t.p('a_driller', 'old.jpg'), false, 'legacy path: Administrator of an organization the owner is not in'),
  ('a_admin',    t.p('b_driller', 'old.jpg'), false, 'legacy path: Administrator of an organization the owner is not in'),
  ('a_admin',    t.p('stranger', 'old.jpg'),  false, 'legacy path: the owner belongs to no organization'),
  ('b_admin',    t.p('stranger', 'old.jpg'),  false, 'legacy path: the owner belongs to no organization'),
  ('stranger',   t.p('a_driller', 'old.jpg'), false, 'legacy path: legacy profiles.role Administrator, no membership'),
  ('dual',       t.p('a_driller', 'old.jpg'), false, 'legacy path: legacy profiles.role Administrator, Driller in A'),
  ('dual',       t.p('b_driller', 'old.jpg'), false, 'legacy path: legacy profiles.role Administrator, Supervisor in B'),
  ('a_exadmin',  t.p('a_driller', 'old.jpg'), false, 'legacy path: a deactivated Administrator'),
  ('mixed',      t.p('a_driller', 'old.jpg'), false, 'legacy path: a deactivated Administrator active elsewhere'),
  ('mixed',      t.p('b_driller', 'old.jpg'), false, 'legacy path: a Driller'),
  ('padmin',     t.p('a_driller', 'old.jpg'), false, 'legacy path: a platform administrator'),
  ('anon',       t.p('a_driller', 'old.jpg'), false, 'legacy path: signed out');

select case when yes
  then t.rows(format('[c11] photos: %s reads %s (%s)', actor, path, why), actor,
              format('select name from storage.objects where bucket_id = ''drilling-photos'' and name = %L', path), 1)
  else t.none(format('[c11][c12] photos: %s cannot read %s (%s)', actor, path, why), actor,
              format('select name from storage.objects where bucket_id = ''drilling-photos'' and name = %L', path))
  end
from t.read_cases order by yes desc, path, actor;

-- "Denied, without an error": a path that is neither form must not make the
-- policy raise (for instance by casting a segment to uuid), for anyone.
--
-- Two of the odd paths start with organization A's id but have no user id as
-- their second segment. Criterion 20: A's Administrator reads every path under
-- <A>/, these included; nobody else does.
create view t.odd as
  select path, path like t.uid('org_a') || '/%' as under_org_a from t.photos where owner is null;
grant select on t.odd to public;

select t.rows(format('[c11] photos: %s reading the odd path %s gets no row and no error', actor, path), actor,
  format('select name from storage.objects where bucket_id = ''drilling-photos'' and name = %L', path), 0)
from t.odd cross join (values ('a_admin'), ('b_admin'), ('a_driller'), ('a_super'), ('padmin'), ('stranger'), ('anon')) v(actor)
where not (actor = 'a_admin' and under_org_a)
order by path, actor;
select t.rows(format('[c20] photos: the Administrator of A reads %s, a path under <A>/ with no user id in it', path), 'a_admin',
  format('select name from storage.objects where bucket_id = ''drilling-photos'' and name = %L', path), 1)
from t.odd where under_org_a order by path;

-- Listing the whole bucket, with the odd paths in it.
select t.ok(format('[c11] photos: %s listing the whole bucket gets no error', actor), actor,
  $$ select count(*) >= 0 from storage.objects where bucket_id = 'drilling-photos' $$)
from (values ('a_admin'), ('b_admin'), ('a_driller'), ('dual'), ('a_super'), ('padmin'), ('stranger')) v(actor);
select t.rows(format('[c11][c12] photos: %s listing the bucket gets exactly %s object(s)', actor, n), actor,
  $$ select name from storage.objects where bucket_id = 'drilling-photos' $$, n)
from (values
  ('a_admin', 8),     -- A/a_driller, A/a_gone, A/dual, A/not-a-uuid/x, A/x, legacy a_driller, legacy dual, legacy a_gone
  ('b_admin', 4),     -- B/dual, B/b_driller, legacy b_driller, legacy dual
  ('a_driller', 2),   -- own new, own legacy
  ('dual', 3),        -- own in A, own in B, own legacy
  ('a_super', 0), ('a_exadmin', 0), ('a_gone', 0), ('padmin', 0), ('anon', 0)
) v(actor, n);

select t.none('[c11] photos: the policies cover the drilling-photos bucket only (reading another bucket)', 'a_driller',
  $$ select name from storage.objects where bucket_id = 'db-test-other' $$);

-- ---------------------------------------------------------------------------
-- Uploading
-- ---------------------------------------------------------------------------

create table t.upload_cases (actor text, path text, yes boolean, why text);
insert into t.upload_cases values
  ('a_driller', t.p('org_a', 'a_driller', 'n.jpg'), true,  'new path: active member, own id'),
  ('a_logger',  t.p('org_a', 'a_logger', 'n.jpg'),  true,  'new path: active member, own id'),
  ('a_super',   t.p('org_a', 'a_super', 'n.jpg'),   true,  'new path: active member, own id'),
  ('b_driller', t.p('org_b', 'b_driller', 'n.jpg'), true,  'new path: active member, own id'),
  ('dual',      t.p('org_a', 'dual', 'n.jpg'),      true,  'new path: member of both, first organization'),
  ('dual',      t.p('org_b', 'dual', 'n.jpg'),      true,  'new path: member of both, second organization'),
  ('a_admin',   t.p('org_a', 'a_admin', 'n.jpg'),   true,  'c20 new path: an Administrator is an active member too'),
  ('b_admin',   t.p('org_b', 'b_admin', 'n.jpg'),   true,  'c20 new path: an Administrator is an active member too'),
  ('a_driller', t.p('a_driller', 'n.jpg'),          true,  'legacy path: own folder'),
  ('b_driller', t.p('b_driller', 'n.jpg'),          true,  'legacy path: own folder'),
  ('a_driller', t.p('org_b', 'a_driller', 'n.jpg'), false, 'new path: own id under an organization they are not in'),
  ('a_driller', t.p('org_b', 'b_driller', 'n.jpg'), false, 'new path: another organization''s member''s folder'),
  ('a_driller', t.p('org_a', 'a_driller2', 'n.jpg'), false, 'new path: a colleague''s id'),
  ('a_admin',   t.p('org_b', 'a_admin', 'n.jpg'),   false, 'new path: Administrator, another organization'),
  ('a_admin',   t.p('org_a', 'a_driller', 'n.jpg'), false, 'new path: Administrator, a member''s folder'),
  ('b_admin',   t.p('org_a', 'b_admin', 'n.jpg'),   false, 'new path: Administrator, another organization'),
  ('a_gone',    t.p('org_a', 'a_gone', 'n.jpg'),    false, 'new path: deactivated member'),
  ('a_exadmin', t.p('org_a', 'a_exadmin', 'n.jpg'), false, 'new path: deactivated Administrator'),
  ('a_invited', t.p('org_a', 'a_invited', 'n.jpg'), false, 'new path: invited, not active'),
  ('mixed',     t.p('org_a', 'mixed', 'n.jpg'),     false, 'new path: deactivated here, active elsewhere'),
  ('stranger',  t.p('org_a', 'stranger', 'n.jpg'),  false, 'new path: no membership'),
  ('padmin',    t.p('org_a', 'padmin', 'n.jpg'),    false, 'new path: platform administrator, no membership'),
  ('anon',      t.p('org_a', 'anon', 'n.jpg'),      false, 'new path: signed out'),
  ('a_driller', t.p('b_driller', 'n.jpg'),          false, 'legacy path: someone else''s folder'),
  ('a_driller', t.p('a_driller2', 'n.jpg'),         false, 'legacy path: a colleague''s folder'),
  ('a_admin',   t.p('a_driller', 'n.jpg'),          false, 'legacy path: Administrator, a member''s folder'),
  ('anon',      t.p('a_driller', 'n.jpg'),          false, 'legacy path: signed out'),
  ('a_driller', 'misc/n.jpg',                       false, 'first segment is neither an organization nor a user'),
  ('a_admin',   'misc/n.jpg',                       false, 'first segment is neither an organization nor a user'),
  ('a_driller', 'n.jpg',                            false, 'no folder at all'),
  ('a_driller', t.uid('org_a') || '/not-a-uuid/n.jpg', false, 'second segment is not a user id'),
  ('a_driller', t.uid('org_a') || '/n.jpg',         false, 'an organization folder with no user folder'),
  ('a_driller', t.uid('nobody') || '/n.jpg',        false, 'first segment is an unknown id'),
  ('a_driller', t.uid('nobody') || '/' || t.uid('a_driller') || '/n.jpg', false, 'own id under an unknown organization id');

select case when yes
  then t.rows(format('[c11] photos: %s uploads %s (%s)', actor, path, why), actor,
              format('insert into storage.objects (bucket_id, name, owner) values (''drilling-photos'', %L, %L)', path, t.uid(actor)), 1)
  else t.throws(format('[c11][c12] photos: %s cannot upload %s (%s): refused with 42501, no other error', actor, path, why), actor,
              format('insert into storage.objects (bucket_id, name, owner) values (''drilling-photos'', %L, %L)', path, t.uid(actor)), '42501')
  end
from t.upload_cases order by yes desc, path, actor;

select t.throws('[c11] photos: the policies cover the drilling-photos bucket only (uploading to another bucket)', 'a_driller',
  format('insert into storage.objects (bucket_id, name, owner) values (''db-test-other'', %L, %L)', t.p('a_driller', 'n.jpg'), t.uid('a_driller')), '42501');

-- ---------------------------------------------------------------------------
-- Changing or removing another organization's photo
-- ---------------------------------------------------------------------------

select t.none(format('[c12] photos: %s cannot move %s into a path of their own', actor, path), actor,
  format('update storage.objects set name = %L where bucket_id = ''drilling-photos'' and name = %L', newpath, path))
from (values
  ('a_admin',   t.p('org_b', 'b_driller', 'p.jpg'), t.p('org_a', 'a_admin', 'stolen.jpg')),
  ('a_driller', t.p('org_b', 'b_driller', 'p.jpg'), t.p('org_a', 'a_driller', 'stolen.jpg')),
  ('a_driller', t.p('b_driller', 'old.jpg'),        t.p('a_driller', 'stolen.jpg')),
  ('b_admin',   t.p('org_a', 'a_driller', 'p.jpg'), t.p('org_b', 'b_admin', 'stolen.jpg'))
) v(actor, path, newpath);
select t.none(format('[c12] photos: %s cannot delete %s', actor, path), actor,
  format('delete from storage.objects where bucket_id = ''drilling-photos'' and name = %L', path))
from (values
  ('a_admin',   t.p('org_b', 'b_driller', 'p.jpg')),
  ('a_driller', t.p('org_b', 'b_driller', 'p.jpg')),
  ('a_driller', t.p('b_driller', 'old.jpg')),
  ('b_admin',   t.p('org_a', 'a_driller', 'p.jpg')),
  ('b_admin',   t.p('a_driller', 'old.jpg'))
) v(actor, path);

rollback;
select 'done';
