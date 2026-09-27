-- Pause and resume a pipe in progress.
--
-- duration_seconds keeps its meaning of "time spent drilling" and is what the
-- penetration rate is computed from; pauses are now taken out of it rather
-- than silently inflating it. The time the crew stood down is recorded
-- alongside, so a pipe's wall-clock span is duration_seconds + paused_seconds.
--
--   paused_seconds  total paused time on the pipe. 0 means never paused; null
--                   means the row came from a build that could not pause.
--   pauses          [{start, end, reason, eventId}], one per pause.
--
-- Each pause is also uploaded the moment it starts as a drilling_events row of
-- type 'Drilling Paused' (details.resumedAt unset while the rig is still
-- paused), so the office can see a stopped rig without waiting for END PIPE.
-- That needs no schema change: drilling_events.type is free text and details
-- is jsonb.
--
-- Columns are nullable and additive, so rows already on the server and uploads
-- from devices still on an older build are unaffected. This migration must be
-- applied before the build that sends these fields ships: PostgREST rejects an
-- upsert naming a column it does not know.

alter table public.pipe_records
  add column if not exists paused_seconds integer,
  add column if not exists pauses jsonb;
