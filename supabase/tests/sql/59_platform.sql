-- SaaS Phase 4, task P4-1: the reusable migration saas_platform.
-- Check names carry [P4-1 cN] for acceptance criterion N of the task.
--
-- ASSUMED (the Developer matches these):
--   * platform_create_organization(p_name text, p_plan text, p_status text,
--       p_ends_at timestamptz default null) returns uuid
--     Its audit row: action 'org.create', details keys plan, status, ends_at.
--   * platform_update_subscription(p_org uuid, p_action text, p_args jsonb default '{}')
--     Args keys: ends_at (extend), plan (change_plan), max_users and features
--     (override: a key that is present is set, JSON null clears it, an absent
--     key is left alone), notes (any action).
--     Its audit row: action 'subscription.<action>', details.before and
--     details.after hold the subscription row before and after, at least the
--     columns the action changed, under the columns' own names (plan_id,
--     status, ends_at, max_users_override, ...), a null as JSON null.
--   * platform_organizations() columns: org_id, name, created_at, plan_id,
--     status, starts_at, ends_at, grace_days, max_users_override,
--     features_override, notes, access, members.
--   * platform_members(p_org uuid) columns: user_id, name, email, role, status.
--     email is the account's; name is its user metadata's "name" (what the
--     member function stores when it creates an account).
--   * A refusal for not being a platform administrator is 42501; the other
--     refusals (unknown plan, status, action, missing argument, no
--     subscription) raise anything that is not a broken call.
--   * start_trial needs no argument and is allowed from any status.
--
-- A refusal raises, so it changes nothing: that is not asserted separately.
-- plan: 31
begin;
\ir ../lib/helpers.sql
\ir ../lib/fixture.sql
\ir inc/members.sql

create function t.a() returns uuid language sql immutable as $$ select t.uid('org_a') $$;
create function t.b() returns uuid language sql immutable as $$ select t.uid('org_b') $$;
create function t.upd(org uuid, action text, args jsonb default '{}') returns text language sql immutable as $$
  select format('select public.platform_update_subscription(%L, %L, %L)', org, action, args) $$;

insert into public.plans (id, name, max_users) values ('t_one', 'Test plan of one', 1), ('t_big', 'Test plan of fifty', 50);
update auth.users set raw_user_meta_data = '{"name": "Ada Admin"}' where id = t.uid('a_admin');
-- Organization A: 7 counting members (6 active, 1 invited), 4 deactivated.
select t.sub(t.a(), 'active', now() + interval '10 days', 5, 9);
update public.subscriptions set starts_at = now() - interval '3 days', notes = 'vip', features_override = '{"photos": false}'
  where org_id = t.a();

-- ---------------------------------------------------------------------------
-- Criteria 1 and 6: creating an organization
-- ---------------------------------------------------------------------------

select t.did('[P4-1 c1] a platform administrator creates an organization', 'padmin',
  $$ select public.platform_create_organization('P4 New Co', 't_one', 'trial', now() + interval '14 days') $$, 1);
select t.ok('[P4-1 c1][c6] ... it exists once, with its subscription (so its access is full) and one audit row org.create: actor, organization, plan, status, end date',
  $$ select count(*) = 1 and bool_and(public.org_access(o.id) = 'full'
        and (select s.plan_id = 't_one' and s.status = 'trial' and s.ends_at = now() + interval '14 days'
             from public.subscriptions s where s.org_id = o.id)
        and (select count(*) = 1 and bool_and(l.actor_id = t.uid('padmin') and l.details ->> 'plan' = 't_one'
                    and l.details ->> 'status' = 'trial' and (l.details ->> 'ends_at')::timestamptz = now() + interval '14 days')
             from public.audit_log l where l.action = 'org.create' and l.org_id = o.id))
     from public.organizations o where o.name = 'P4 New Co' $$);
select t.throws('[P4-1 c6] ... and its user limit applies: its plan allows one member, two are refused with SS001', null,
  $$ insert into public.memberships (org_id, user_id, role, status)
     select o.id, u, 'Driller', 'active' from public.organizations o, unnest(array[t.uid('stranger'), t.uid('padmin')]) u
     where o.name = 'P4 New Co' $$, 'SS001');
select t.refused(format('[P4-1 c1] creating an organization with %s is refused', why), 'padmin',
  format('select public.platform_create_organization(''P4 Refused'', %L, %L)', plan, st), 'create', why)
from (values ('no_such_plan', 'active', 'an unknown plan'), ('standard', 'suspended', 'a status other than trial or active')) v(plan, st, why);

-- ---------------------------------------------------------------------------
-- Criterion 3: the console's reads
-- ---------------------------------------------------------------------------

select t.ok('[P4-1 c3] platform_organizations(): one row per organization, with its name, creation date, subscription, access level and counting members', 'padmin',
  format($$ select (select count(*) from public.platform_organizations()) = (select count(*) from public.organizations)
               and (select count(*) from public.platform_organizations() r
                    where r.org_id = %L and r.name = 'Org A' and r.created_at = now() and r.plan_id = 'standard' and r.status = 'active'
                      and r.starts_at = now() - interval '3 days' and r.ends_at = now() + interval '10 days' and r.grace_days = 5
                      and r.max_users_override = 9 and r.features_override = '{"photos": false}' and r.notes = 'vip'
                      and r.access = 'full' and r.members = 7) = 1 $$, t.a()));
select t.ok('[P4-1 c3] platform_members(): every member of the organization, with user id, name, email, role and status', 'padmin',
  format($$ select count(*) = 11 and count(*) filter (where status = 'deactivated') = 4
               and count(*) filter (where user_id = %L and name = 'Ada Admin' and email = 'a_admin@db-test.invalid'
                                      and role = 'Administrator' and status = 'active') = 1
            from public.platform_members(%L) $$, t.uid('a_admin'), t.a()));

-- ---------------------------------------------------------------------------
-- Criterion 2: changing a subscription
-- ---------------------------------------------------------------------------

-- One action on organization A as the platform administrator, kept. `want`
-- is a condition on the subscription row s afterwards; `col` is the column
-- whose values the audit row must carry before and after.
create function t.act(action text, args jsonb, col text, want text) returns text
language plpgsql as $f$
declare
  name text := format('[P4-1 c2] %1$s: the subscription changes (%2$s), and one audit row subscription.%1$s carries actor, organization and %3$s before and after',
                      action, want, col);
  seen bigint := (select coalesce(max(id), 0) from public.audit_log);
  b jsonb := (select to_jsonb(s) from public.subscriptions s where s.org_id = t.a());
  a jsonb;
  line text;
  changed boolean;
  logged boolean;
begin
  line := t.did(name, 'padmin', t.upd(t.a(), action, args), 1);
  if line like 'FAIL%' then return line; end if;
  select to_jsonb(s) into a from public.subscriptions s where s.org_id = t.a();
  execute format('select %s from public.subscriptions s where s.org_id = $1', want) into changed using t.a();
  select count(*) = 1 and bool_and(l.action = 'subscription.' || act.action and l.actor_id = t.uid('padmin') and l.org_id = t.a()
                                   and l.details -> 'before' -> col = b -> col and l.details -> 'after' -> col = a -> col)
    into logged from public.audit_log l where l.id > seen;
  return t._line(name, coalesce(changed and logged, false),
    format('subscription as expected: %s; audit row as expected: %s', coalesce(changed::text, 'null'), coalesce(logged::text, 'null')));
end
$f$;

select t.act(action, args, col, want)
from (values
  (1, 'start_trial', '{}'::jsonb, 'status', $$s.status = 'trial'$$),
  (2, 'activate',    '{}', 'status', $$s.status = 'active'$$),
  (3, 'extend',      jsonb_build_object('ends_at', now() + interval '30 days'), 'ends_at', $$s.ends_at = now() + interval '30 days'$$),
  (4, 'change_plan', '{"plan": "t_big"}', 'plan_id', $$s.plan_id = 't_big'$$),
  (5, 'override',    '{"max_users": 3, "features": {"photos": true}}', 'max_users_override',
      $$s.max_users_override = 3 and s.features_override = '{"photos": true}'$$),
  (6, 'override',    '{"max_users": null}', 'max_users_override',
      $$s.max_users_override is null and s.features_override = '{"photos": true}'$$),
  (7, 'suspend',     '{"notes": "unpaid"}', 'status',
      $$s.status = 'suspended' and s.notes = 'unpaid' and public.org_access(s.org_id) = 'none'$$),
  (8, 'reactivate',  '{}', 'status', $$s.status = 'active' and public.org_access(s.org_id) = 'full'$$),
  (9, 'cancel',      '{}', 'status', $$s.status = 'canceled' and s.plan_id = 't_big' and s.ends_at = now() + interval '30 days'$$)
) v(n, action, args, col, want)
order by n;

delete from public.subscriptions where org_id = t.b();
select t.refused(format('[P4-1 c2] %s is refused', why), 'padmin', t.upd(org, action), 'update', why)
from (values (t.a(), 'delete',  'an unknown action'),
             (t.a(), 'extend',  'extend without ends_at'),
             (t.b(), 'suspend', 'an action on an organization without a subscription')) v(org, action, why);

select t.ok('[P4-1 c3] a platform administrator reads the new audit rows: actor, time, action and details', 'padmin',
  format($$ select count(*) = 10 and bool_and(actor_id = %L and at is not null and details is not null)
            from public.audit_log where action = 'org.create' or action like 'subscription.%%' $$, t.uid('padmin')));

-- ---------------------------------------------------------------------------
-- Criteria 4 and 5: nobody else, and nothing more for the platform administrator
-- ---------------------------------------------------------------------------

select t.throws(format('[P4-1 c4] %s is refused with 42501 for %s', fn, who), actor, q, '42501')
from (values
  ('platform_create_organization', 'an organization''s Administrator', 'a_admin',
     $$ select public.platform_create_organization('P4 Mine', 'standard', 'active') $$),
  ('platform_update_subscription', 'an Administrator extending their own organization', 'a_admin',
     t.upd(t.a(), 'extend', jsonb_build_object('ends_at', now() + interval '10 years'))),
  ('platform_organizations',       'an ordinary member', 'a_driller', 'select * from public.platform_organizations()'),
  ('platform_members',             'an Administrator asking for their own organization', 'a_admin',
     format('select * from public.platform_members(%L)', t.a())),
  ('platform_organizations',       'a signed-out client', 'anon', 'select * from public.platform_organizations()')
) v(fn, who, actor, q);
select t.ok('[P4-1 c4] anon holds no EXECUTE on any of the four functions',
  $$ select count(*) = 4 and not bool_or(coalesce(has_function_privilege('anon', to_regprocedure('public.' || f), 'EXECUTE'), true))
     from unnest(array['platform_create_organization(text,text,text,timestamptz)', 'platform_update_subscription(uuid,text,jsonb)',
                       'platform_organizations()', 'platform_members(uuid)']) f $$);
select t.throws('[P4-1 c4] a platform administrator still cannot add a platform administrator through the API', 'padmin',
  format('insert into public.platform_admins (user_id) values (%L)', t.uid('stranger')), '42501');

select t.ok('[P4-1 c5] a platform administrator who is a member of no organization reads none of the record tables (D4-1)', 'padmin',
  $$ select (select count(*) from public.boreholes) + (select count(*) from public.pipe_records)
          + (select count(*) from public.drilling_events) + (select count(*) from public.shift_logs) = 0 $$);
select t.throws(format('[P4-1 c5] a platform administrator cannot %s an audit row', op), 'padmin', q, '42501')
from (values ('update', $$ update public.audit_log set details = '{}' $$), ('delete', 'delete from public.audit_log')) v(op, q);

rollback;
select 'done';
