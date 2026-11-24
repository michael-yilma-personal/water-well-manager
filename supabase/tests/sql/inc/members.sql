-- Helpers for the member-management tests (SaaS Phase 2, task P2-1).
-- Requires lib/helpers.sql; the caller owns the transaction.
--
-- Check names carry [P2-1 cN] for criterion N of "P2-1 acceptance criteria"
-- in docs/saas/IMPLEMENTATION_STATUS.md. A bare [cN] is a Phase 1 criterion.

-- The account's membership in one organization, as role/status/badge.
create function t.mo(actor text, org uuid) returns text
language sql stable
as $$
  select coalesce((select format('%s/%s/%s', role, status, coalesce(badge_number, '-'))
                   from public.memberships where user_id = t.uid(actor) and org_id = org), 'no membership')
$$;

-- Every membership of the account, ordered by organization id.
create function t.m(actor text) returns text
language sql stable
as $$
  select coalesce(string_agg(format('%s/%s/%s', role, status, coalesce(badge_number, '-')), ' + ' order by org_id), 'no membership')
  from public.memberships where user_id = t.uid(actor)
$$;

-- The legacy profile, as role/badge. plpgsql, so that this file also loads
-- where there is no profiles table (the foundation alone, core/).
create function t.p(actor text) returns text
language plpgsql stable
as $f$
begin
  return coalesce((select format('%s/%s', role, coalesce(badge_number, '-')) from public.profiles where id = t.uid(actor)), 'no profile');
end
$f$;

-- The calls, as the Edge Function will make them. Arguments are sent as
-- untyped literals, so only the argument ORDER of the criteria is assumed.
create function t.add(org uuid, member uuid, role text, badge text, status text, actor uuid) returns text
language sql immutable
as $$ select format('select public.saas_add_member(%L, %L, %L, %L, %L, %L)', org, member, role, badge, status, actor) $$;

create function t.set_role(org uuid, member uuid, role text, actor uuid) returns text
language sql immutable
as $$ select format('select public.saas_set_member_role(%L, %L, %L, %L)', org, member, role, actor) $$;

create function t.set_badge(org uuid, member uuid, badge text, actor uuid) returns text
language sql immutable
as $$ select format('select public.saas_set_member_badge(%L, %L, %L, %L)', org, member, badge, actor) $$;

create function t.set_status(org uuid, member uuid, status text, actor uuid) returns text
language sql immutable
as $$ select format('select public.saas_set_member_status(%L, %L, %L, %L)', org, member, status, actor) $$;

create function t.remove(org uuid, member uuid, actor uuid) returns text
language sql immutable
as $$ select format('select public.saas_remove_member(%L, %L, %L)', org, member, actor) $$;

-- An error that says the CALL is broken (no such function, no such column, a
-- syntax error, no EXECUTE for the role that must have it), not that the
-- function refused. A refusal check must not pass on one of these: before the
-- migration exists every call "raises", with 42883.
create function t.broken(state text, msg text) returns boolean
language sql immutable
as $$
  select state in ('42883', '42P01', '42703', '42601', '42804', '42725', '42846', '42P02', '3F000')
      or coalesce(msg, '') ~* '^permission denied for (function|table|schema|sequence|relation)'
$$;

-- Messages are compared with the ids taken out, so that two refusals that
-- differ only in the id they quote count as the same message.
create function t.norm(msg text) returns text
language sql immutable
as $$ select lower(regexp_replace(coalesce(msg, ''), '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '<id>', 'g')) $$;

-- What each refusal raised. `kind` names the rule that was broken; null for
-- extra inputs that are not part of the "can be told apart" check.
create table t.refusals (fn text, kind text, state text, msg text);

-- q is refused BY THE FUNCTION: it raises, and not with an error that says
-- the call itself is broken. A raise undoes the statement, so "changing
-- nothing" follows. No SQLSTATE is asserted: the criteria name none.
create function t.refused(name text, actor text, q text, fn text, kind text) returns text
language plpgsql
as $f$
declare r record;
begin
  r := t._try(actor, q, false);
  insert into t.refusals values (fn, kind, r.state, r.msg);
  return t._line(name, r.state <> '00000' and not t.broken(r.state, r.msg),
    case when r.state = '00000' then 'expected a refusal, but it succeeded (' || coalesce(r.n::text, '?') || ' row(s))'
         else 'expected a refusal by the function, got error ' || r.state || ': ' || r.msg end);
end
$f$;

-- The refusals of one function can be told apart: no two different rules
-- raised the same SQLSTATE with the same message. `kinds` is how many rules
-- were tried, so a file that loses one fails here too.
create function t.distinguishable(name text, fn_ text, kinds int) returns text
language plpgsql
as $f$
declare
  tried int;
  bad int;
  clash text;
begin
  select count(distinct kind) into tried from t.refusals where fn = fn_ and kind is not null;
  select count(*) into bad from t.refusals where fn = fn_ and kind is not null and (state = '00000' or t.broken(state, msg));
  select string_agg(distinct a.kind || ' = ' || b.kind || ' (' || a.state || ' ' || left(a.msg, 60) || ')', '; ')
    into clash
    from t.refusals a join t.refusals b
      on a.fn = b.fn and a.kind < b.kind and a.state = b.state and t.norm(a.msg) = t.norm(b.msg)
    where a.fn = fn_;
  return t._line(name, tried = kinds and bad = 0 and clash is null,
    case when tried <> kinds then 'expected ' || kinds || ' kinds of refusal to have been tried, found ' || tried
         when bad > 0 then bad || ' of the refusals did not happen (see the checks above)'
         else 'the same error for different rules: ' || clash end);
end
$f$;

-- Memberships, legacy profiles, the accounts' bans and the audit log, as one
-- value: what a call that must change nothing must leave alone.
create function t.state_digest() returns text
language plpgsql stable
as $f$
declare
  profiles text := '';
begin
  -- No profiles table where the foundation stands alone (core/).
  if to_regclass('public.profiles') is not null then
    execute $q$ select coalesce(string_agg(p.id::text || ':' || p.role || ':' || coalesce(p.badge_number, ''), '|' order by p.id), '') from public.profiles p $q$
      into profiles;
  end if;
  return md5(
    coalesce((select string_agg(m::text, '|' order by m.org_id, m.user_id) from public.memberships m), '') || '#' ||
    profiles || '#' ||
    coalesce((select string_agg(u.id::text || ':' || coalesce(u.banned_until::text, ''), '|' order by u.id) from auth.users u), '') || '#' ||
    (select count(*)::text from public.audit_log));
end
$f$;

-- q, run as actor, changes nothing: it may raise or return, but memberships,
-- profiles, bans and the audit log are afterwards what they were. Used where
-- the criteria do not say WHETHER the call raises (a member who has no
-- membership in the organization, for the functions other than set_role). An
-- error that says the call itself is broken fails the check.
create function t.no_change(name text, actor text, q text) returns text
language plpgsql
as $f$
declare
  before text;
  after text;
  st text := '00000';
  m text;
begin
  begin
    before := t.state_digest();
    perform t._become(actor);
    begin
      execute q;
    exception when others then
      st := sqlstate;
      m := sqlerrm;
    end;
    perform set_config('role', 'none', true);
    perform set_config('request.jwt.claims', '', true);
    after := t.state_digest();
    raise exception using errcode = 'TR001', message = 'undo';
  exception
    when sqlstate 'TR001' then null;
  end;
  return t._line(name, not t.broken(st, m) and before is not null and before = after,
    case when t.broken(st, m) then 'not checked, the call itself is broken: ' || st || ': ' || m
         else 'memberships, profiles, bans or the audit log changed (the call ' ||
              case when st = '00000' then 'returned' else 'raised ' || st end || ')' end);
end
$f$;

-- The audit rows written since the last t.mark_audit().
create table t.audit_mark (id bigint not null);
insert into t.audit_mark values (0);

create function t.mark_audit() returns text
language sql
as $$ update t.audit_mark set id = coalesce((select max(id) from public.audit_log), 0) returning '' $$;

-- Exactly one audit row since the mark, naming this actor, this organization
-- and this member (target is the member's user id), with an action. Sets the
-- mark again. What `action` and `details` hold is the Developer's choice and
-- is not asserted beyond "an action is named".
create function t.audited(name text, actor uuid, org uuid, member uuid) returns text
language plpgsql
as $f$
declare
  n int;
  good int;
  seen text;
begin
  select count(*),
         count(*) filter (where a.actor_id = actor and a.org_id = org and lower(a.target) = member::text
                            and a.action is not null and a.action <> ''),
         string_agg(format('actor %s org %s action %s target %s', a.actor_id, a.org_id, a.action, a.target), '; ')
    into n, good, seen
    from public.audit_log a where a.id > (select id from t.audit_mark);
  perform t.mark_audit();
  return t._line(name, n = 1 and good = 1,
    case when n = 0 then 'no audit row was written'
         else n || ' audit row(s): ' || left(seen, 300) end);
end
$f$;

-- The same for accept_membership / decline_membership, where the criteria
-- name the actor only ("the caller as actor"): one row, that actor, that
-- organization.
create function t.audited_own(name text, actor uuid, org uuid) returns text
language plpgsql
as $f$
declare
  n int;
  good int;
  seen text;
begin
  select count(*),
         count(*) filter (where a.actor_id = actor and a.org_id = org and a.action is not null and a.action <> ''),
         string_agg(format('actor %s org %s action %s target %s', a.actor_id, a.org_id, a.action, a.target), '; ')
    into n, good, seen
    from public.audit_log a where a.id > (select id from t.audit_mark);
  perform t.mark_audit();
  return t._line(name, n = 1 and good = 1,
    case when n = 0 then 'no audit row was written'
         else n || ' audit row(s): ' || left(seen, 300) end);
end
$f$;

grant select on all tables in schema t to public;
