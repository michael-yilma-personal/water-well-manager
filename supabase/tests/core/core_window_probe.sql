-- Decision 42 (RF-083): one look at the database between two statements of
-- saas_core, when it is NOT applied as one transaction, on a database with a
-- hosted project's default grants (every new table in public is granted in
-- full to anon and authenticated the moment it is created). Included after
-- every statement by the script lib/sql_statements.py writes;
-- supabase/tests/local.sh reads t_probe.results afterwards.
--
-- For each foundation table that exists at this point, a signed-out client
-- (anon) and a signed-in one (authenticated) each try an INSERT, an UPDATE
-- and a DELETE. None may get through. Each attempt is undone.
--
-- "Get through" is judged by what happens, not by reading the ACL: an insert
-- that runs, or an update or delete that changes a row. For the update and
-- the delete there has to be a row, so one is put there first by the role
-- applying the migration; for the insert only what the new row refers to is.
-- The signed-in client is the very user those rows are about (the member,
-- the platform administrator), the one a careless policy would let through.
--
-- t_probe.results.state:
--   00000   refused: SQLSTATE 42501, or it ran and changed nothing
--   OPEN    it went through
--   SEED    the probe could not put its own row there (msg says why)
--   other   the attempt failed with something that is not a refusal
do $probe$
declare
  stmt text := current_setting('drill.stmt');
  who uuid := md5('drill-db-test:l_driller')::uuid;
  org uuid := md5('drill-db-test:probe-org')::uuid;
  tbl text;
  r text;
  verb text;
  q text;
  c bigint;
begin
  foreach tbl in array array['organizations', 'memberships', 'platform_admins', 'audit_log'] loop
    continue when to_regclass('public.' || tbl) is null;
    foreach r in array array['anon', 'authenticated'] loop
      foreach verb in array array['insert', 'update', 'delete'] loop
        begin
          -- What must be there first, written by the migration's own role.
          begin
            if tbl = 'memberships' or (tbl = 'organizations' and verb <> 'insert') then
              insert into public.organizations (id, name) values (org, 'probe seed');
            end if;
            if verb <> 'insert' then
              if tbl = 'memberships' then
                insert into public.memberships (org_id, user_id, role) values (org, who, 'probe');
              elsif tbl = 'platform_admins' then
                insert into public.platform_admins (user_id) values (who);
              elsif tbl = 'audit_log' then
                insert into public.audit_log (action) values ('probe seed');
              end if;
            end if;
          exception when others then
            raise exception using errcode = 'TR003', message = sqlstate || ' ' || sqlerrm;
          end;

          q := case tbl || ' ' || verb
            when 'organizations insert'   then format('insert into public.organizations (name) values (%L)', 'probe')
            when 'organizations update'   then format('update public.organizations set name = name where id = %L', org)
            when 'organizations delete'   then format('delete from public.organizations where id = %L', org)
            when 'memberships insert'     then format('insert into public.memberships (org_id, user_id, role) values (%L, %L, %L)', org, who, 'probe')
            when 'memberships update'     then format('update public.memberships set role = role where org_id = %L and user_id = %L', org, who)
            when 'memberships delete'     then format('delete from public.memberships where org_id = %L and user_id = %L', org, who)
            when 'platform_admins insert' then format('insert into public.platform_admins (user_id) values (%L)', who)
            when 'platform_admins update' then format('update public.platform_admins set user_id = user_id where user_id = %L', who)
            when 'platform_admins delete' then format('delete from public.platform_admins where user_id = %L', who)
            when 'audit_log insert'       then format('insert into public.audit_log (action) values (%L)', 'probe')
            when 'audit_log update'       then format('update public.audit_log set action = action where action = %L', 'probe seed')
            when 'audit_log delete'       then format('delete from public.audit_log where action = %L', 'probe seed')
          end;

          if r = 'anon' then
            perform set_config('request.jwt.claims', '{"role":"anon"}', true);
          else
            perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
          end if;
          perform set_config('role', r, true);
          execute q;
          get diagnostics c = row_count;
          -- Undo the attempt, the seed and the role switch, carrying the count out.
          raise exception using errcode = case when c > 0 then 'TR001' else 'TR002' end, message = c::text;
        exception
          when sqlstate 'TR001' then
            insert into t_probe.results values (stmt, r || ' ' || verb || ' ' || tbl, 'OPEN', 'it went through (' || sqlerrm || ' row)');
          when sqlstate 'TR002' then
            insert into t_probe.results values (stmt, r || ' ' || verb || ' ' || tbl, '00000', null);
          when sqlstate 'TR003' then
            insert into t_probe.results values (stmt, r || ' ' || verb || ' ' || tbl, 'SEED', sqlerrm);
          when insufficient_privilege then
            insert into t_probe.results values (stmt, r || ' ' || verb || ' ' || tbl, '00000', null);
          when others then
            insert into t_probe.results values (stmt, r || ' ' || verb || ' ' || tbl, sqlstate, sqlerrm);
        end;
      end loop;
    end loop;
  end loop;
end
$probe$;
