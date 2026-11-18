-- Criterion 48 (RF-091), for run.sh: the Drill rollback raises, and changes
-- nothing, when a NON-founding organization that has no members still holds a
-- record row or a photo (guards/c48_fixture.sql builds the state; :what and
-- :founding_empty choose the case). With :what = nothing the second
-- organization holds nothing and the rollback must run.
--
-- Run by run.sh with ON_ERROR_STOP, so psql leaves at the first error and the
-- open transaction is rolled back by the server. run.sh reads the markers:
-- FIXTURE-READY must be printed; REACHED-END must not, except with
-- :what = nothing, where it must, after ROLLED-BACK. :rollback_drill is the
-- script's path.
begin;

\ir c48_fixture.sql

\i :rollback_drill

select case when not exists (select 1 from pg_attribute where attrelid = 'public.boreholes'::regclass and attname = 'org_id' and not attisdropped)
            then 'ROLLED-BACK' else 'NOT-ROLLED-BACK' end;
select 'REACHED-END';
rollback;
