-- Two organizations that both hold record rows, committed. Loaded by
-- supabase/tests/local.sh into a scratch database before it tries the Drill
-- rollback there (decision 31). guards/rollback_refuses.sql builds the same
-- thing inside a transaction for run.sh.
insert into public.organizations (id, name) values ('7e57da7a-0000-4000-8000-000000000002', 'Second company');
insert into auth.users (id, email) values ('7e57da7a-0000-4000-8000-0000000000a1', 'guard1@db-test.invalid');
insert into public.boreholes (id, name, created_by, recorded_at, org_id)
  select '7e57da7a-0000-4000-8000-0000000000b1', 'first company hole', '7e57da7a-0000-4000-8000-0000000000a1', now(), id
  from public.organizations where id <> '7e57da7a-0000-4000-8000-000000000002';
insert into public.boreholes (id, name, created_by, recorded_at, org_id)
  values ('7e57da7a-0000-4000-8000-0000000000b2', 'second company hole', '7e57da7a-0000-4000-8000-0000000000a1', now(),
          '7e57da7a-0000-4000-8000-000000000002');
