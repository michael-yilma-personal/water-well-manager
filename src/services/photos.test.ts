import assert from 'node:assert/strict';
import test from 'node:test';
import { scaledDimensions, photoNames, MAX_EDGE, THUMB_EDGE } from './photos';

test('a landscape phone photo is bounded by its long edge', () => {
  // Typical 12MP phone camera frame.
  const out = scaledDimensions(4032, 3024, MAX_EDGE);
  assert.equal(out.width, 1600);
  assert.equal(out.height, 1200);
});

test('a portrait photo scales on height, not width', () => {
  const out = scaledDimensions(3024, 4032, MAX_EDGE);
  assert.equal(out.height, 1600);
  assert.equal(out.width, 1200);
});

test('aspect ratio is preserved', () => {
  const src = { w: 4000, h: 2250 }; // 16:9
  const out = scaledDimensions(src.w, src.h, MAX_EDGE);
  assert.ok(
    Math.abs(out.width / out.height - src.w / src.h) < 0.01,
    `distorted: ${out.width}x${out.height}`
  );
});

test('an already-small image is left alone', () => {
  // Re-encoding upward would cost bytes and quality for nothing.
  const out = scaledDimensions(800, 600, MAX_EDGE);
  assert.deepEqual(out, { width: 800, height: 600 });
});

test('an image exactly at the bound is left alone', () => {
  assert.deepEqual(scaledDimensions(1600, 900, MAX_EDGE), { width: 1600, height: 900 });
});

test('thumbnails are bounded far smaller, which is what keeps egress down', () => {
  const out = scaledDimensions(4032, 3024, THUMB_EDGE);
  assert.equal(out.width, 320);
  assert.equal(out.height, 240);
});

test('never scales to a zero dimension', () => {
  // An extreme panorama would otherwise round the short edge to 0 and produce
  // a canvas that cannot be drawn.
  const out = scaledDimensions(20000, 30, MAX_EDGE);
  assert.equal(out.width, 1600);
  assert.ok(out.height >= 1, `height rounded to ${out.height}`);
});

test('degenerate input does not throw', () => {
  assert.deepEqual(scaledDimensions(0, 0, MAX_EDGE), { width: 0, height: 0 });
});

test('a photo and its thumbnail have distinct, derivable names', () => {
  const { full, thumb } = photoNames('abc-123');
  assert.equal(full, 'abc-123.jpg');
  assert.equal(thumb, 'abc-123_thumb.jpg');
  assert.notEqual(full, thumb);
});
