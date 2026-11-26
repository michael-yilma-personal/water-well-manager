-- SaaS Phase 3, task P3-1: the reusable migration saas_subscriptions.
-- Check names carry [P3-1 cN] for acceptance criterion N of the task.
--
-- ASSUMED where the criteria leave the choice to the Developer:
--   * plans and subscriptions have (at least) the columns of proposal 5.1;
--     the plan every existing organization gets has the id 'standard'.
--   * org_access(uuid) returns text: 'full', 'read_only' or 'none'.
--   * The user-limit refusal raises SQLSTATE SS001, from the trigger and
--     unchanged through saas_add_member (what the Edge Function sees).
--   * my_organizations() names its two new columns `access` and `ends_at`.
--   * A subscription row can be written by the table owner with an upsert on
--     org_id (the fixture of decision D3-3), whether or not the migration
--     gives a new organization a row of its own.
--   * D3-8 (changed after the review of P3-1): no client reads `subscriptions`
--     directly, a member of the organization included; what a client may
--     know comes from my_organizations(). `plans` stays readable.
--
-- Subscriptions are set by the connecting role; dates are relative to now(),
-- which does not move inside this transaction.
-- plan: 35
begin;
\ir ../lib/helpers.sql

-- Criterion 5, before the fixture adds organizations of its own.
select t.ok('[P3-1 c5] every organization that exists after the migrations has a subscription: plan standard, status active, no end date',
  $$ select (select count(*) from public.organizations) >= 1
        and not exists (select 1 from public.organizations o
                        where not exists (select 1 from public.subscriptions s
                                          where s.org_id = o.id and s.plan_id = 'standard' and s.status = 'active' and s.ends_at is null))
        and (select is_active and max_users > 0 from public.plans where id = 'standard') $$);

\ir ../lib/fixture.sql
\ir inc/members.sql

create function t.a() returns uuid language sql immutable as $$ select t.uid('org_a') $$;
create function t.b() returns uuid language sql immutable as $$ select t.uid('org_b') $$;

-- t.sub(org, status, ends_at, grace, limit, plan) sets a subscription: lib/fixture.sql.

-- ---------------------------------------------------------------------------
-- Criterion 1: the tables, who reads them, and that nobody writes them
-- ---------------------------------------------------------------------------

select t.sub(t.a(), 'active', null);
select t.sub(t.b(), 'active', null);

select t.ok('[P3-1 c1] plans and subscriptions exist with the columns of proposal 5.1 and row level security enabled',
  $$ select (select count(*) from pg_class where oid in (to_regclass('public.plans'), to_regclass('public.subscriptions')) and relrowsecurity) = 2
        and (select array_agg(attname::text) from pg_attribute where attrelid = to_regclass('public.plans') and attnum > 0 and not attisdropped)
            @> array['id', 'name', 'max_users', 'features', 'is_active']
        and (select array_agg(attname::text) from pg_attribute where attrelid = to_regclass('public.subscriptions') and attnum > 0 and not attisdropped)
            @> array['org_id', 'plan_id', 'status', 'starts_at', 'ends_at', 'grace_days', 'max_users_override', 'features_override', 'notes'] $$);
select t.ok('[P3-1 c1] anon and authenticated hold no INSERT, UPDATE or DELETE privilege on plans or subscriptions',
  $$ select not exists (select 1 from unnest(array['anon', 'authenticated']) r, unnest(array['plans', 'subscriptions']) tbl,
                                      unnest(array['INSERT', 'UPDATE', 'DELETE']) p
                        where has_table_privilege(r, 'public.' || tbl, p)) $$);
select t.none('[P3-1 c1] an organization''s Administrator cannot change its subscription', 'a_admin',
  format('update public.subscriptions set status = ''active'', ends_at = null, max_users_override = 1000 where org_id = %L', t.a()));
select t.none('[P3-1 c1] ... nor add a plan', 'a_admin',
  $$ insert into public.plans (id, name, max_users) values ('free_for_all', 'Mine', 1000) $$);

select t.rows('[P3-1 c1] a member reads the plans', 'a_driller',
  $$ select 1 from public.plans where id = 'standard' $$, 1);
select t.none(format('[P3-1 c1] %s cannot read organization A''s subscription by its id', why), actor,
  format('select * from public.subscriptions where org_id = %L', t.a()))
from (values ('a_driller', 'a member of the organization itself (D3-8)'),
             ('a_admin',  'the organization''s own Administrator (D3-8)'),
             ('b_admin',  'the Administrator of another organization'),
             ('a_gone',   'a deactivated member'),
             ('stranger', 'an account with no membership'),
             ('anon',     'a signed-out client')) v(actor, why);

-- ---------------------------------------------------------------------------
-- Criterion 2: org_access(), state by state (proposal section 8, D3-1)
-- ---------------------------------------------------------------------------

select t.ok('[P3-1 c2] org_access(uuid) returns text and is stable, security definer, search_path = public',
  $$ select coalesce((select p.provolatile = 's' and p.prosecdef and p.proconfig @> array['search_path=public']
                             and pg_get_function_result(p.oid) = 'text'
                      from pg_proc p where p.oid = to_regprocedure('public.org_access(uuid)')), false) $$);

-- Sets organization A's subscription, then asks as one of its members.
create function t.access(st text, ends interval, grace int, want text, why text) returns text
language plpgsql as $f$
declare name text := format('[P3-1 c2] org_access is %s for %s', want, why);
begin
  if st is null then
    delete from public.subscriptions where org_id = t.a();
  else
    perform t.sub(t.a(), st, now() + ends, grace);
  end if;
  return t.ok(name, 'a_driller', format('select public.org_access(%L) = %L', t.a(), want));
exception when others then
  return t._line(name, false, 'the subscription could not be set: ' || sqlerrm);
end
$f$;

select t.access(st, ends, grace, want, why)
from (values
  (1, 'trial',     interval '1 day',   7, 'full',      'a trial before its end date'),
  (2, 'active',    null,               7, 'full',      'an active subscription with no end date'),
  (3, 'active',    interval '-3 days', 7, 'full',      'an active subscription 3 days past its end date with 7 days of grace'),
  (4, 'active',    interval '-3 days', 2, 'read_only', 'the same with 2 days of grace (grace_days is the row''s, not a constant)'),
  (5, 'trial',     interval '-8 days', 7, 'read_only', 'a trial 8 days past its end date with 7 days of grace (expired)'),
  (6, 'suspended', null,               7, 'none',      'a suspended subscription'),
  (7, 'canceled',  interval '30 days', 7, 'none',      'a canceled subscription, even before its end date'),
  (8, null,        null,               7, 'none',      'an organization with no subscription row (D3-1)'),
  (9, 'active',    interval '0',       0, 'full',      'an active subscription whose end date is this very moment, with no grace (the end is inclusive)')
) v(n, st, ends, grace, want, why)
order by n;

-- ---------------------------------------------------------------------------
-- Criterion 4: my_organizations() adds the access level and the end date
-- ---------------------------------------------------------------------------

-- dual: Driller in A (ends in 10 days), Supervisor in B (no subscription row).
select t.sub(t.a(), 'active', now() + interval '10 days');
delete from public.subscriptions where org_id = t.b();

select t.ok('[P3-1 c4] my_organizations(): each row carries its own organization''s access level and end date, next to the columns it had', 'dual',
  format($$ select count(*) = 2
               and count(*) filter (where org_id = %1$L and name = 'Org A' and role = 'Driller' and status = 'active'
                                      and access = 'full' and ends_at = now() + interval '10 days') = 1
               and count(*) filter (where org_id = %2$L and name = 'Org B' and role = 'Supervisor' and status = 'active'
                                      and access = 'none' and ends_at is null) = 1
            from public.my_organizations() $$, t.a(), t.b()));

select t.ok('[P3-1 c4] my_organizations(): a membership that is not active carries neither the access level nor the end date', 'a_invited',
  $$ select count(*) = 1 and bool_and(status = 'invited' and access is null and ends_at is null) from public.my_organizations() $$);

-- ---------------------------------------------------------------------------
-- Criterion 3: the user limit (D3-2: active and invited count)
-- ---------------------------------------------------------------------------

-- Organization B has five active members and nobody else.
insert into public.plans (id, name, max_users) values ('t_five', 'Test plan of five', 5);
select t.sub(t.b(), 'active', null, 7, null, 't_five');

select t.throws('[P3-1 c3] at the plan''s limit, saas_add_member is refused with SS001', 'service',
  t.add(t.b(), t.uid('stranger'), 'Driller', null, 'active', t.uid('b_admin')), 'SS001');
select t.throws('[P3-1 c3] ... and so is a plain insert of an invited membership: SS001', null,
  format('insert into public.memberships (org_id, user_id, role, status) values (%L, %L, ''Driller'', ''invited'')', t.b(), t.uid('stranger')), 'SS001');
select t.throws('[P3-1 c3] ... and so is moving a membership into it by changing its org_id: SS001', null,
  format('update public.memberships set org_id = %L where org_id = %L and user_id = %L', t.b(), t.a(), t.uid('a_logger')), 'SS001');
select t.rows('[P3-1 c3] ... with its subscription row gone the organization has no limit: the same person is added (D3-5)', null,
  format('with gone as (delete from public.subscriptions where org_id = %1$L returning org_id) '
         'insert into public.memberships (org_id, user_id, role, status) select org_id, %2$L, ''Driller'', ''active'' from gone', t.b(), t.uid('stranger')), 1);
select t.rows('[P3-1 c3] ... a deactivated membership does not count: it is inserted', null,
  format('insert into public.memberships (org_id, user_id, role, status) values (%L, %L, ''Driller'', ''deactivated'')', t.b(), t.uid('stranger')), 1);

select t.sub(t.b(), 'active', null, 7, 6, 't_five');
select t.did('[P3-1 c3] max_users_override replaces the plan''s limit: with 6 a sixth person is invited', null,
  format('insert into public.memberships (org_id, user_id, role, status) values (%L, %L, ''Driller'', ''invited'')', t.b(), t.uid('stranger')), 1);
select t.throws('[P3-1 c3] ... and the invitation holds the last seat: a seventh person is refused with SS001', null,
  format('insert into public.memberships (org_id, user_id, role, status) values (%L, %L, ''Driller'', ''active'')', t.b(), t.uid('padmin')), 'SS001');

-- Organization A has six active members, one invited and four deactivated.
select t.sub(t.a(), 'active', null, 7, 7);
select t.throws('[P3-1 c3] at the limit, re-activating a deactivated member is refused with SS001', null,
  format('update public.memberships set status = ''active'' where org_id = %L and user_id = %L', t.a(), t.uid('a_gone')), 'SS001');
select t.rows('[P3-1 c3] ... an invited member becoming active is not: they held a seat already', null,
  format('update public.memberships set status = ''active'' where org_id = %L and user_id = %L', t.a(), t.uid('a_invited')), 1);
select t.sub(t.a(), 'active', null, 7, 3);
select t.rows('[P3-1 c3] with the limit lowered below the count, a member can still be deactivated', null,
  format('update public.memberships set status = ''deactivated'' where org_id = %L and user_id = %L', t.a(), t.uid('a_driller')), 1);

rollback;
select 'done';
