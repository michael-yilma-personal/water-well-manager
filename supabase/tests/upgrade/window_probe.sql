-- Decision 29: one look at the database between two statements of the Drill
-- migration, when it is NOT applied as one transaction. Included after every
-- statement by the script lib/sql_statements.py writes; supabase/tests/local.sh
-- reads t_probe.results afterwards.
--
-- From the moment a table has its org_id column, the installed build (which
-- sends no org_id) must still be able to insert into it: the legacy driller
-- of upgrade/seed_legacy.sql adds a borehole, and a pipe record to their old
-- borehole, as `authenticated`. Each attempt is undone.
do $probe$
declare
  who uuid := md5('drill-db-test:l_driller')::uuid;
  hole uuid := md5('drill-db-test:boreholes:l_driller')::uuid;
  stmt text := current_setting('drill.stmt');
  tbl text;
begin
  foreach tbl in array array['boreholes', 'pipe_records'] loop
    continue when not exists (
      select 1 from pg_attribute
      where attrelid = ('public.' || tbl)::regclass and attname = 'org_id' and not attisdropped);
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', who, 'role', 'authenticated')::text, true);
      perform set_config('role', 'authenticated', true);
      if tbl = 'boreholes' then
        insert into public.boreholes (id, name, created_by, recorded_at)
          values (gen_random_uuid(), 'probe', who, now());
      else
        insert into public.pipe_records (id, borehole_id, pipe_number, created_by, recorded_at)
          values (gen_random_uuid(), hole, 99, who, now());
      end if;
      raise exception using errcode = 'TR001', message = 'undo';
    exception
      when sqlstate 'TR001' then
        insert into t_probe.results values (stmt, tbl, '00000', null);
      when others then
        insert into t_probe.results values (stmt, tbl, sqlstate, sqlerrm);
    end;
  end loop;
end
$probe$;
