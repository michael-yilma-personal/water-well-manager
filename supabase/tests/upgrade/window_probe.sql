-- Decision 29: one look at the database between two statements of the Drill
-- migration, when it is NOT applied as one transaction. Included after every
-- statement by the script lib/sql_statements.py writes; supabase/tests/local.sh
-- reads t_probe.results afterwards.
--
-- From the moment a table has its org_id column, the installed build (which
-- sends no org_id) must still be able to insert into it: the legacy driller
-- of upgrade/seed_legacy.sql adds a borehole and, to their old borehole, a
-- pipe record, an event and a shift log, as `authenticated`. Each attempt is
-- undone.
--
-- Added in validation:
--   * all four record tables, not two: with the default of drilling_events or
--     shift_logs dropped before the triggers existed, or their insert policy
--     dropped in a statement of its own, the probe saw nothing;
--   * the photo upload an installed build makes (<user_id>/<file>), from the
--     first statement on: it is an insert too, and it has no org_id either;
--   * what the installed build reads: its own borehole and its own photo,
--     from the first statement on. Decision 29 speaks of inserts only; this
--     pins the migration's own rule that a policy is dropped and re-created
--     in one statement, for the two read policies an insert cannot see;
--   * an account created at this point (what the dashboard's "add user" does),
--     which is KEPT: local.sh tries an insert as each of them once the
--     migration is through, then removes them.
do $probe$
declare
  who uuid := md5('drill-db-test:l_driller')::uuid;
  hole uuid := md5('drill-db-test:boreholes:l_driller')::uuid;
  stmt text := current_setting('drill.stmt');
  tbl text;
begin
  foreach tbl in array array['boreholes', 'pipe_records', 'drilling_events', 'shift_logs', 'photo upload'] loop
    continue when tbl <> 'photo upload' and not exists (
      select 1 from pg_attribute
      where attrelid = ('public.' || tbl)::regclass and attname = 'org_id' and not attisdropped);
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      if tbl = 'boreholes' then
        insert into public.boreholes (id, name, created_by, recorded_at)
          values (gen_random_uuid(), 'probe', who, now());
      elsif tbl = 'pipe_records' then
        insert into public.pipe_records (id, borehole_id, pipe_number, created_by, recorded_at)
          values (gen_random_uuid(), hole, 99, who, now());
      elsif tbl = 'drilling_events' then
        insert into public.drilling_events (id, borehole_id, created_by, recorded_at)
          values (gen_random_uuid(), hole, who, now());
      elsif tbl = 'shift_logs' then
        insert into public.shift_logs (id, borehole_id, created_by, recorded_at)
          values (gen_random_uuid(), hole, who, now());
      else
        insert into storage.objects (bucket_id, name, owner)
          values ('drilling-photos', who || '/probe-' || gen_random_uuid() || '.jpg', who);
      end if;
      raise exception using errcode = 'TR001', message = 'undo';
    exception
      when sqlstate 'TR001' then
        insert into t_probe.results values (stmt, tbl, '00000', null);
      when others then
        insert into t_probe.results values (stmt, tbl, sqlstate, sqlerrm);
    end;
  end loop;

  foreach tbl in array array['read own borehole', 'read own photo'] loop
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      if tbl = 'read own borehole' then
        perform 1 from public.boreholes where id = hole;
      else
        perform 1 from storage.objects where bucket_id = 'drilling-photos' and name = who || '/old.jpg';
      end if;
      -- Undo the role switch, carrying out whether the row was there.
      raise exception using errcode = case when found then 'TR001' else 'TR002' end, message = 'undo';
    exception
      when sqlstate 'TR001' then
        insert into t_probe.results values (stmt, tbl, '00000', null);
      when sqlstate 'TR002' then
        insert into t_probe.results values (stmt, tbl, 'EMPTY', 'the row was not returned');
      when others then
        insert into t_probe.results values (stmt, tbl, sqlstate, sqlerrm);
    end;
  end loop;

  -- Kept. The address carries the statement's number.
  insert into auth.users (id, email)
    values (md5('drill-db-test:window:' || stmt)::uuid, 'window-' || left(stmt, 3) || '@db-test.invalid');
end
$probe$;
