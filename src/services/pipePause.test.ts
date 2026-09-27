import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeOpenPause,
  drillingSeconds,
  isPaused,
  pauseTimer,
  pausedSeconds,
  resumeTimer,
} from './pipePause';
import type { ActivePipeTimer } from '../types';

const T0 = Date.parse('2026-09-27T08:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000).toISOString();

const running: ActivePipeTimer = {
  boreholeId: 'bh',
  isActive: true,
  pipeNumber: 7,
  startDepth: 27.3,
  startTime: at(0),
  formation: 'Weathered Basalt',
};

test('a pipe that was never paused drills for its whole elapsed time', () => {
  assert.equal(isPaused(running), false);
  assert.equal(drillingSeconds(running, T0 + 10 * 60_000), 600);
});

test('pausing marks the timer paused and freezes drilling time', () => {
  const paused = pauseTimer(running, 'Waiting on fuel', at(10), 'ev-1');
  assert.equal(isPaused(paused), true);
  assert.equal(drillingSeconds(paused, T0 + 10 * 60_000), 600);
  // Twenty minutes later the clock has not moved: the bit is not turning.
  assert.equal(drillingSeconds(paused, T0 + 30 * 60_000), 600);
  assert.equal(pausedSeconds(paused.pauses, T0 + 30 * 60_000), 1200);
});

test('pausing twice does not open a second pause', () => {
  const once = pauseTimer(running, 'Weather', at(5), 'ev-1');
  const twice = pauseTimer(once, 'Other', at(6), 'ev-2');
  assert.equal(twice.pauses?.length, 1);
  assert.equal(twice.pauses?.[0].reason, 'Weather');
});

test('resuming closes the pause and the clock picks up where it stopped', () => {
  const paused = pauseTimer(running, 'Crew break', at(10), 'ev-1');
  const resumed = resumeTimer(paused, at(25));
  assert.equal(isPaused(resumed), false);
  assert.equal(resumed.pauses?.[0].end, at(25));
  assert.equal(drillingSeconds(resumed, T0 + 40 * 60_000), 25 * 60);
  assert.equal(pausedSeconds(resumed.pauses, T0 + 40 * 60_000), 15 * 60);
});

test('several pauses on one pipe all come off the drilling time', () => {
  let t = pauseTimer(running, 'Weather', at(5), 'ev-1');
  t = resumeTimer(t, at(10));
  t = pauseTimer(t, 'Safety stop', at(20), 'ev-2');
  t = resumeTimer(t, at(22));
  assert.equal(t.pauses?.length, 2);
  assert.equal(pausedSeconds(t.pauses, T0 + 30 * 60_000), 7 * 60);
  assert.equal(drillingSeconds(t, T0 + 30 * 60_000), 23 * 60);
});

test('resuming a timer that is not paused changes nothing', () => {
  assert.deepEqual(resumeTimer(running, at(3)), running);
});

test('an idle timer cannot be paused', () => {
  const idle = { ...running, isActive: false };
  assert.deepEqual(pauseTimer(idle, 'Weather', at(1), 'ev-1'), idle);
});

test('ending a paused pipe closes the open pause at the end time', () => {
  const paused = pauseTimer(running, 'Hole problem', at(10), 'ev-1');
  const closed = closeOpenPause(paused.pauses, at(18));
  assert.equal(closed[0].end, at(18));
  assert.equal(pausedSeconds(closed, T0 + 60 * 60_000), 8 * 60);
});

test('a clock stepped backwards never produces negative time', () => {
  const paused = pauseTimer(running, 'Other', at(10), 'ev-1');
  assert.equal(pausedSeconds(paused.pauses, T0), 0);
  assert.equal(drillingSeconds(running, T0 - 60_000), 0);
});
