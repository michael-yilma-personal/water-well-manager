/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ActivePipeTimer, PipePause } from '../types';

/**
 * Pausing a pipe in progress.
 *
 * A crew stops mid-pipe for all sorts of reasons - fuel, weather, a hose, a
 * break - and before this the only honest options were to end the pipe early
 * or to let the timer run. Ending early writes a short pipe that never
 * happened; letting it run divides the pipe's length by an hour of standing
 * still, and the penetration rate in the client's log is then wrong.
 *
 * So the timer keeps a list of pauses, and every duration derived from it
 * leaves them out. All functions here are pure and take `now` explicitly.
 */

/** Reasons offered on the pause sheet, in the order a crew reaches for them. */
export const PAUSE_REASONS = [
  'Crew break / meal',
  'Waiting on fuel or water',
  'Mechanical problem',
  'Weather',
  'Safety stop',
  'Hole problem',
  'Waiting on instructions',
  'Other',
] as const;

const ms = (iso: string) => Date.parse(iso);

export function isPaused(timer: Pick<ActivePipeTimer, 'isActive' | 'pauses'>): boolean {
  return !!timer.isActive && !!timer.pauses?.some((p) => !p.end);
}

export function openPause(timer: Pick<ActivePipeTimer, 'pauses'>): PipePause | undefined {
  return timer.pauses?.find((p) => !p.end);
}

/** Seconds spent paused, counting an open pause up to `nowMs`. */
export function pausedSeconds(pauses: PipePause[] | undefined, nowMs: number): number {
  const total = (pauses ?? []).reduce((sum, p) => {
    const end = p.end ? ms(p.end) : nowMs;
    return sum + Math.max(0, end - ms(p.start));
  }, 0);
  return Math.floor(total / 1000);
}

/** Seconds the bit has actually been drilling on this pipe. */
export function drillingSeconds(
  timer: Pick<ActivePipeTimer, 'startTime' | 'pauses'>,
  nowMs: number
): number {
  const elapsed = Math.floor((nowMs - ms(timer.startTime)) / 1000);
  return Math.max(0, elapsed - pausedSeconds(timer.pauses, nowMs));
}

export function pauseTimer(
  timer: ActivePipeTimer,
  reason: string,
  nowIso: string,
  eventId: string
): ActivePipeTimer {
  if (!timer.isActive || isPaused(timer)) return timer;
  return {
    ...timer,
    pauses: [...(timer.pauses ?? []), { start: nowIso, reason, eventId }],
  };
}

export function closeOpenPause(pauses: PipePause[] | undefined, nowIso: string): PipePause[] {
  return (pauses ?? []).map((p) => (p.end ? p : { ...p, end: nowIso }));
}

export function resumeTimer(timer: ActivePipeTimer, nowIso: string): ActivePipeTimer {
  if (!isPaused(timer)) return timer;
  return { ...timer, pauses: closeOpenPause(timer.pauses, nowIso) };
}
