-- Criterion 47 (RF-088): one look at the database between two statements of
-- the Drill ROLLBACK, when it is NOT applied as one transaction. Included
-- before the first statement (drill.stmt starts with 000) and after every
-- statement by the script supabase/tests/local.sh builds with
-- lib/sql_statements.py; local.sh reads t_probe.results afterwards.
--
-- Written before the rollback was made statement-safe, from the criterion
-- alone. Two things are looked at, each attempt undone:
--
-- (a) Nobody signed in can change their own profiles.role. The restored
--     policies trust that column, so one state in which it can be written is
--     an Administrator for good. The legacy driller and the legacy supervisor
--     of upgrade/seed_legacy.sql try to make themselves Administrator:
--       own role: driller, update            update ... set role
--       own role: driller, update with name  the same beside a column they may change
--       own role: driller, upsert            insert ... on conflict (id) do update set role
--       own role: supervisor, update
--     Judged by what happens, not by reading the ACL: the role is read back.
--     t_probe.results.state:
--       00000    refused: it raised, or it ran, and the role is what it was
--                (msg holds the SQLSTATE when it raised)
--       CHANGED  the role was changed
--     Under `control: <the same label>` the very same statement is run by the
--     role applying the rollback. There 00000 means it DID change the role:
--     the statement is a valid one, so a refusal above is a refusal and not a
--     typo. local.sh requires that before the first statement and after the
--     last only.
--
-- (b) What an installed build does, as the legacy driller, role
--     `authenticated`, never mentioning org_id:
--       insert <table>      a new row in each of the four record tables
--       upsert <table>      their own existing row sent again (on conflict (id) do update)
--       read own <table>    their own existing row of each table
--       read own profile
--       photo upload        to <user_id>/<file>
--       read own photo      <user_id>/old.jpg
--     state is 00000 when it worked, EMPTY when a read (or an upsert) ran and
--     touched no row, the SQLSTATE otherwise. local.sh requires of every
--     state that it is 00000, or what the same operation gave before the
--     first statement, or what it gives after the last: never anything worse.
do $probe$
declare
  who uuid := md5('drill-db-test:l_driller')::uuid;
  super uuid := md5('drill-db-test:l_super')::uuid;
  hole uuid := md5('drill-db-test:boreholes:l_driller')::uuid;
  stmt text := current_setting('drill.stmt');
  op text;
  tbl text;
  actor uuid;
  was text;
  q text;
  c bigint;
  controlled boolean;
begin
  -- (a) -----------------------------------------------------------------------
  foreach op in array array['own role: driller, update', 'own role: driller, update with name',
                            'own role: driller, upsert', 'own role: supervisor, update'] loop
    actor := case when op like 'own role: supervisor%' then super else who end;
    q := case op
      when 'own role: driller, update with name' then
        format('update public.profiles set name = name, role = ''Administrator'' where id = %L', actor)
      when 'own role: driller, upsert' then
        format('insert into public.profiles (id, name, role) values (%L, ''probe'', ''Administrator'') on conflict (id) do update set role = excluded.role', actor)
      else
        format('update public.profiles set role = ''Administrator'' where id = %L', actor)
    end;
    select role into was from public.profiles where id = actor;

    foreach controlled in array array[true, false] loop
      begin
        if not controlled then
          perform set_config('request.jwt.claims', json_build_object('sub', actor, 'role', 'authenticated')::text, true);
          perform set_config('role', 'authenticated', true);
        end if;
        begin
          execute q;
        exception when others then
          -- The attempt raised: nothing was changed. Carry the SQLSTATE out.
          raise exception using errcode = 'TR002', message = sqlstate || ' ' || sqlerrm;
        end;
        perform set_config('role', 'none', true);
        if (select role from public.profiles where id = actor) is distinct from was then
          raise exception using errcode = 'TR001', message = 'the role was changed';
        end if;
        raise exception using errcode = 'TR002', message = 'ran, role unchanged';
      exception
        when sqlstate 'TR001' then
          if controlled then
            insert into t_probe.results values (stmt, 'control: ' || op, '00000', null);
          else
            insert into t_probe.results values (stmt, op, 'CHANGED', format('%s made themselves Administrator (was %s)', actor, was));
          end if;
        when sqlstate 'TR002' then
          if controlled then
            insert into t_probe.results values (stmt, 'control: ' || op, 'INERT', sqlerrm);
          else
            insert into t_probe.results values (stmt, op, '00000', sqlerrm);
          end if;
        when others then
          insert into t_probe.results values (stmt, case when controlled then 'control: ' else '' end || op, sqlstate, sqlerrm);
      end;
    end loop;
  end loop;

  -- (b) writes ------------------------------------------------------------------
  foreach op in array array['insert', 'upsert'] loop
    foreach tbl in array array['boreholes', 'pipe_records', 'drilling_events', 'shift_logs'] loop
      begin
        perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
        perform set_config('role', 'authenticated', true);
        if op = 'insert' then
          if tbl = 'boreholes' then
            insert into public.boreholes (id, name, created_by, recorded_at)
              values (gen_random_uuid(), 'probe', who, now());
          elsif tbl = 'pipe_records' then
            insert into public.pipe_records (id, borehole_id, pipe_number, created_by, recorded_at)
              values (gen_random_uuid(), hole, 99, who, now());
          elsif tbl = 'drilling_events' then
            insert into public.drilling_events (id, borehole_id, created_by, recorded_at)
              values (gen_random_uuid(), hole, who, now());
          else
            insert into public.shift_logs (id, borehole_id, created_by, recorded_at)
              values (gen_random_uuid(), hole, who, now());
          end if;
        else
          -- The row the seed gave this driller, sent again as the sync does.
          if tbl = 'boreholes' then
            insert into public.boreholes (id, name, created_by, recorded_at)
              values (hole, 'BH-1', who, now())
              on conflict (id) do update set name = 'resent';
          elsif tbl = 'pipe_records' then
            insert into public.pipe_records (id, borehole_id, pipe_number, start_depth, end_depth, formation, created_by, recorded_at)
              values (md5('drill-db-test:pipe_records:l_driller')::uuid, hole, 1, 0, 6, 'Clay', who, now())
              on conflict (id) do update set formation = 'Resent';
          elsif tbl = 'drilling_events' then
            insert into public.drilling_events (id, borehole_id, created_by, recorded_at)
              values (md5('drill-db-test:drilling_events:l_driller')::uuid, hole, who, now())
              on conflict (id) do update set title = 'resent';
          else
            insert into public.shift_logs (id, borehole_id, created_by, recorded_at)
              values (md5('drill-db-test:shift_logs:l_driller')::uuid, hole, who, now())
              on conflict (id) do update set notes = 'resent';
          end if;
        end if;
        get diagnostics c = row_count;
        raise exception using errcode = case when c > 0 then 'TR001' else 'TR002' end, message = 'undo';
      exception
        when sqlstate 'TR001' then
          insert into t_probe.results values (stmt, op || ' ' || tbl, '00000', null);
        when sqlstate 'TR002' then
          insert into t_probe.results values (stmt, op || ' ' || tbl, 'EMPTY', 'it ran and wrote no row');
        when others then
          insert into t_probe.results values (stmt, op || ' ' || tbl, sqlstate, sqlerrm);
      end;
    end loop;
  end loop;

  begin
    perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    insert into storage.objects (bucket_id, name, owner)
      values ('drilling-photos', who || '/probe-' || gen_random_uuid() || '.jpg', who);
    raise exception using errcode = 'TR001', message = 'undo';
  exception
    when sqlstate 'TR001' then
      insert into t_probe.results values (stmt, 'photo upload', '00000', null);
    when others then
      insert into t_probe.results values (stmt, 'photo upload', sqlstate, sqlerrm);
  end;

  -- (b) reads -------------------------------------------------------------------
  foreach op in array array['read own boreholes', 'read own pipe_records', 'read own drilling_events',
                            'read own shift_logs', 'read own profile', 'read own photo'] loop
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      if op = 'read own boreholes' then
        perform 1 from public.boreholes where id = hole;
      elsif op = 'read own pipe_records' then
        perform 1 from public.pipe_records where id = md5('drill-db-test:pipe_records:l_driller')::uuid;
      elsif op = 'read own drilling_events' then
        perform 1 from public.drilling_events where id = md5('drill-db-test:drilling_events:l_driller')::uuid;
      elsif op = 'read own shift_logs' then
        perform 1 from public.shift_logs where id = md5('drill-db-test:shift_logs:l_driller')::uuid;
      elsif op = 'read own profile' then
        perform 1 from public.profiles where id = who;
      else
        perform 1 from storage.objects where bucket_id = 'drilling-photos' and name = who || '/old.jpg';
      end if;
      -- Undo the role switch, carrying out whether the row was there.
      raise exception using errcode = case when found then 'TR001' else 'TR002' end, message = 'undo';
    exception
      when sqlstate 'TR001' then
        insert into t_probe.results values (stmt, op, '00000', null);
      when sqlstate 'TR002' then
        insert into t_probe.results values (stmt, op, 'EMPTY', 'the row was not returned');
      when others then
        insert into t_probe.results values (stmt, op, sqlstate, sqlerrm);
    end;
  end loop;
end
$probe$;
