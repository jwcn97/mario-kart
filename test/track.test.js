import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRACK_LAYOUT, buildTrack, wrapDelta } from '../game/track.js';

const track = buildTrack();
const close = (a, b, eps) => assert.ok(Math.abs(a - b) < eps, `expected ${b} ± ${eps}, got ${a}`);

test('the loop is closed and resampled about every metre', () => {
  const { samples } = track;
  assert.ok(track.length > 800 && track.length < 1200, `length ${track.length}`);
  close(track.step, TRACK_LAYOUT.spacing, 0.05);
  const first = samples[0];
  const last = samples.at(-1);
  close(Math.hypot(first.x - last.x, first.z - last.z), track.step, 0.1);
  close(first.x, TRACK_LAYOUT.points[0][0], 0.01); // the finish line is the first control point
  close(first.z, TRACK_LAYOUT.points[0][1], 0.01);
});

test('directions are unit length and "right" is 90° clockwise from travel', () => {
  for (const p of track.samples) {
    close(Math.hypot(p.tx, p.tz), 1, 1e-9);
    close(p.rx, -p.tz, 1e-12);
    close(p.rz, p.tx, 1e-12);
  }
});

test('no two parts of the track are close enough to share a barrier', () => {
  const { samples } = track;
  const n = samples.length;
  let min = Infinity;
  for (let i = 0; i < n; i += 2) {
    for (let j = i + 1; j < n; j += 2) {
      const along = Math.min(j - i, n - (j - i)) * track.step;
      if (along < 80) continue;
      min = Math.min(min, Math.hypot(samples[i].x - samples[j].x, samples[i].z - samples[j].z));
    }
  }
  assert.ok(min > 2 * TRACK_LAYOUT.barrierOffset, `closest approach ${min.toFixed(1)} m`);
});

test('barriers never fold back on themselves, and always clear the road', () => {
  const { samples } = track;
  const road = track.roadHalfWidth + track.kerbWidth;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i];
    const b = samples[(i + 1) % samples.length];
    for (const [sign, key] of [
      [-1, 'barrierLeft'],
      [1, 'barrierRight'],
    ]) {
      assert.ok(a[key] > road + 1.5, `sample ${i} ${key} is ${a[key]}`);
      assert.ok(a[key] <= TRACK_LAYOUT.barrierOffset + 1e-9);
      const forward =
        (b.x + b.rx * sign * b[key] - (a.x + a.rx * sign * a[key])) * a.tx +
        (b.z + b.rz * sign * b[key] - (a.z + a.rz * sign * a[key])) * a.tz;
      assert.ok(forward > 0, `${key} folds back at sample ${i}`);
    }
  }
});

test('locate: on the centre line, lateral is 0 and s matches', () => {
  for (const i of [0, 100, 437, track.samples.length - 1]) {
    const p = track.samples[i];
    const where = track.locate(p.x, p.z);
    assert.equal(where.index, i);
    close(where.lateral, 0, 1e-9);
    close(where.s, p.s, 1e-9);
  }
});

test('locate: positive lateral is to the right of travel', () => {
  const p = track.samples[200];
  const where = track.locate(p.x + p.rx * 5, p.z + p.rz * 5);
  close(where.lateral, 5, 1e-6);
  assert.ok(track.isOffRoad(10) && !track.isOffRoad(-7.5));
});

test('locate: s is smooth between samples', () => {
  const a = track.samples[300];
  const where = track.locate(a.x + a.tx * 0.4, a.z + a.tz * 0.4, 300);
  close(where.s, a.s + 0.4, 1e-6);
});

test('locate with a hint only looks nearby', () => {
  // A point by sample 500, but we claim the kart was at sample 100: the answer stays near 100.
  const far = track.samples[500];
  const where = track.locate(far.x, far.z, 100);
  assert.ok(Math.abs(where.index - 100) <= 12, `jumped to ${where.index}`);
});

test('pointAt: heading matches the direction of travel', () => {
  const p = track.pointAt(123.4);
  close(Math.sin(p.heading), p.tx, 1e-9);
  close(Math.cos(p.heading), p.tz, 1e-9);
  const wrapped = track.pointAt(123.4 + track.length);
  close(wrapped.x, p.x, 1e-9);
});

test('the grid is behind the finish line, on the road, facing forward', () => {
  for (const slot of [1, 2, 3, 4]) {
    const g = track.gridPosition(slot);
    const where = track.locate(g.x, g.z);
    const behind = wrapDelta(where.s, track.length);
    assert.ok(behind < -5 && behind > -25, `slot ${slot} is ${behind} m from the line`);
    assert.ok(!track.isOffRoad(where.lateral));
    const f = { x: Math.sin(g.heading), z: Math.cos(g.heading) };
    assert.ok(f.x * where.tx + f.z * where.tz > 0.99);
  }
  // Nobody shares a spot.
  const spots = [1, 2, 3, 4].map((s) => track.gridPosition(s));
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    assert.ok(Math.hypot(spots[i].x - spots[j].x, spots[i].z - spots[j].z) > 3);
  }
});

test('wrapDelta takes the short way round the loop', () => {
  assert.equal(wrapDelta(10, 100), 10);
  assert.equal(wrapDelta(95, 100), -5);
  assert.equal(wrapDelta(-95, 100), 5);
});
