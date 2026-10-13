import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS,
  SteeringProcessor,
  applyDeadZone,
  gravityInPhoneFrame,
  readWheelAngle,
  shapeSteering,
  smoothingWeight,
  toScreenFrame,
  uprightness,
  wheelAngleDeg,
  wrapDeg,
} from '../controller/steering.js';

const close = (actual, expected, eps = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < eps, `expected ${expected}, got ${actual}`);

const closeVec = (v, x, y, z) => {
  close(v.x, x);
  close(v.y, y);
  close(v.z, z);
};

// A wheel held level in landscape (phone turned counter-clockwise, screen angle 90),
// then turned clockwise by `turnDeg`. Returns gravity in screen axes.
const landscapeGravity = (turnDeg) => {
  const t = (turnDeg * Math.PI) / 180;
  return { x: Math.sin(t), y: -Math.cos(t), z: 0 };
};

test('gravity in phone frame: flat on a table points out the back', () => {
  closeVec(gravityInPhoneFrame(0, 0), 0, 0, -1);
});

test('gravity in phone frame: upright portrait points to the bottom edge', () => {
  closeVec(gravityInPhoneFrame(90, 0), 0, -1, 0);
});

test('gravity in phone frame: upright landscape (gamma -90) points to the left edge', () => {
  closeVec(gravityInPhoneFrame(0, -90), -1, 0, 0);
});

test('screen frame: upright landscape reads as level on screen', () => {
  const screen = toScreenFrame(gravityInPhoneFrame(0, -90), 90);
  closeVec(screen, 0, -1, 0);
  close(wheelAngleDeg(screen), 0);
  close(uprightness(screen), 1);
});

test('screen frame: portrait needs no rotation', () => {
  const v = { x: 0.2, y: -0.9, z: 0.1 };
  closeVec(toScreenFrame(v, 0), 0.2, -0.9, 0.1);
});

test('wheel angle: clockwise turn is positive, counter-clockwise negative', () => {
  close(wheelAngleDeg(landscapeGravity(20)), 20);
  close(wheelAngleDeg(landscapeGravity(-35)), -35);
});

test('readWheelAngle: returns null when the phone lies flat', () => {
  const { angleDeg, upright } = readWheelAngle({ beta: 2, gamma: -3, screenAngleDeg: 90 });
  assert.equal(angleDeg, null);
  assert.ok(upright < 0.35);
});

test('readWheelAngle: phone tilted back 45 degrees still steers', () => {
  // Landscape, leaning back so the screen faces the player and the sky.
  const { angleDeg, upright } = readWheelAngle({ beta: 0, gamma: -45, screenAngleDeg: 90 });
  close(angleDeg, 0, 1e-6);
  close(upright, Math.SQRT1_2, 1e-6);
});

test('wrapDeg keeps angles in [-180, 180)', () => {
  close(wrapDeg(190), -170);
  close(wrapDeg(-190), 170);
  close(wrapDeg(360), 0);
  close(wrapDeg(45), 45);
});

test('dead zone: zero inside, continuous outside', () => {
  assert.equal(applyDeadZone(2, 3), 0);
  assert.equal(applyDeadZone(-3, 3), 0);
  close(applyDeadZone(5, 3), 2);
  close(applyDeadZone(-5, 3), -2);
});

test('shapeSteering: full lock at max angle, clamped beyond it', () => {
  const s = { ...DEFAULT_SETTINGS, curve: 0 };
  close(shapeSteering(s.maxAngleDeg, s), 1);
  close(shapeSteering(-90, s), -1);
  close(shapeSteering(0, s), 0);
});

test('shapeSteering: curve softens small tilts but keeps the endpoints', () => {
  const linear = shapeSteering(15, { ...DEFAULT_SETTINGS, curve: 0 });
  const curved = shapeSteering(15, { ...DEFAULT_SETTINGS, curve: 1 });
  assert.ok(curved < linear);
  close(shapeSteering(DEFAULT_SETTINGS.maxAngleDeg, { ...DEFAULT_SETTINGS, curve: 1 }), 1);
});

test('shapeSteering: invert flips the sign', () => {
  const a = shapeSteering(20, DEFAULT_SETTINGS);
  const b = shapeSteering(20, { ...DEFAULT_SETTINGS, invert: true });
  close(a, -b);
});

test('smoothingWeight: 0 ms constant means no smoothing', () => {
  assert.equal(smoothingWeight(16, 0), 1);
  const w = smoothingWeight(16, 60);
  assert.ok(w > 0 && w < 1);
});

test('processor: first sample becomes the centre', () => {
  const p = new SteeringProcessor();
  p.update(12, 0);
  assert.equal(p.centerDeg, 12);
  assert.equal(p.value, 0);
});

test('processor: smoothing converges to the target', () => {
  const p = new SteeringProcessor({ curve: 0, smoothingMs: 60 });
  p.update(0, 0);
  let t = 0;
  p.update(35, (t += 16));
  assert.ok(p.value > 0 && p.value < 0.5, `first step should be partial, got ${p.value}`);
  for (let i = 0; i < 60; i++) p.update(35, (t += 16));
  close(p.value, 1, 1e-3);
});

test('processor: recenter treats the current hold as straight ahead', () => {
  const p = new SteeringProcessor({ smoothingMs: 0 });
  p.update(0, 0);
  p.update(25, 16);
  assert.ok(p.value > 0);
  p.recenter();
  assert.equal(p.value, 0);
  p.update(25, 32);
  assert.equal(p.value, 0);
});

test('processor: release eases back to straight and keeps the centre', () => {
  const p = new SteeringProcessor({ smoothingMs: 0 });
  p.update(5, 0);
  p.update(25, 16); // 20 degrees right of centre
  const before = p.value;
  let t = 16;
  p.release((t += 16));
  assert.ok(p.value > 0 && p.value < before, `first release step should be partial, got ${p.value}`);
  for (let i = 0; i < 60; i++) p.release((t += 16));
  close(p.value, 0, 1e-3);
  assert.equal(p.centerDeg, 5);
});

test('processor: works across the ±180 seam', () => {
  const p = new SteeringProcessor({ smoothingMs: 0, curve: 0, deadZoneDeg: 0 });
  p.update(175, 0); // centre near the seam
  p.update(-170, 16); // 15 degrees clockwise, across the seam
  close(p.angleDeg, 15);
  close(p.value, 15 / 35);
});
