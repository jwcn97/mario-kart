import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KART_PARAMS as P,
  collideKarts,
  collideWithArena,
  collideWithObstacle,
  createKart,
  forwardOf,
  interpolate,
  nextSpeed,
  stepKart,
  stepWorld,
  turnGrip,
} from '../game/physics.js';
import { createFixedStep } from '../game/loop.js';

const DT = 1 / 120;
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `expected ${b}, got ${a}`);

/** Run a kart for `seconds` with a fixed input. */
function drive(kart, input, seconds) {
  for (let t = 0; t < seconds; t += DT) stepKart(kart, input, DT);
  return kart;
}

// ---------- Speed ----------

test('gas accelerates up to top speed and no further', () => {
  const kart = drive(createKart(), { gas: true }, 10);
  close(kart.speed, P.maxSpeed, 1e-9);
});

test('reaching top speed takes a couple of seconds, not an instant', () => {
  const kart = drive(createKart(), { gas: true }, 1);
  assert.ok(kart.speed > 8 && kart.speed < P.maxSpeed, `speed after 1 s: ${kart.speed}`);
});

test('letting go coasts to a stop', () => {
  const kart = createKart();
  kart.speed = 10;
  drive(kart, {}, 6);
  assert.equal(kart.speed, 0);
});

test('brake stops quickly, then holding it backs up to reverse top speed', () => {
  const kart = createKart();
  kart.speed = P.maxSpeed;
  drive(kart, { brake: true }, 0.5);
  assert.ok(kart.speed < 12, `half a second of braking from top speed: ${kart.speed}`);
  drive(kart, { brake: true }, 5);
  close(kart.speed, -P.maxReverse, 1e-9);
});

test('gas while reversing brakes first', () => {
  assert.ok(nextSpeed(-5, { gas: true }, DT) > -5 + P.accel * DT);
});

test('gas and brake together: brake wins', () => {
  assert.ok(nextSpeed(10, { gas: true, brake: true }, DT) < 10);
});

// ---------- Steering ----------

test('no turning on the spot; full grip at moderate speed; a bit less at top speed', () => {
  assert.equal(turnGrip(0), 0);
  close(turnGrip(P.fullTurnSpeed), 1 - P.topSpeedTurnLoss * (P.fullTurnSpeed / P.maxSpeed));
  assert.ok(turnGrip(P.maxSpeed) < turnGrip(10));
});

test('steering right moves the kart towards its right side', () => {
  // Facing +z, "right" for the driver is -x (x = right as the camera behind sees it).
  const kart = createKart();
  kart.speed = 10;
  drive(kart, { steer: 1, gas: true }, 0.5);
  assert.ok(kart.heading < 0, 'heading decreases when turning right');
  const right = { x: -Math.cos(0), z: Math.sin(0) };
  assert.ok(kart.x * right.x + kart.z * right.z > 0, `ended at x=${kart.x}`);
});

test('reversing with the wheel turned flips the turn, like a real car', () => {
  const forward = createKart();
  forward.speed = 5;
  drive(forward, { steer: 1 }, 0.2);
  const backward = createKart();
  backward.speed = -5;
  drive(backward, { steer: 1 }, 0.2);
  assert.ok(forward.heading < 0 && backward.heading > 0);
});

test('a full right-hand circle at steady speed brings the kart back where it started', () => {
  const kart = createKart();
  kart.speed = P.maxSpeed; // at top speed with gas held, speed stays constant
  const input = { steer: 1, gas: true };
  let turned = 0;
  while (turned < 2 * Math.PI) {
    const before = kart.heading;
    stepKart(kart, input, DT);
    turned += before - kart.heading;
  }
  assert.ok(Math.hypot(kart.x, kart.z) < 1, `ended ${Math.hypot(kart.x, kart.z).toFixed(2)} m from the start`);
});

// ---------- Collisions ----------

test('arena walls stop the kart and bounce it back a little', () => {
  const arena = { halfWidth: 10, halfDepth: 10 };
  const kart = createKart({ z: 9.5 }); // facing +z, into the far wall
  kart.speed = 20;
  assert.ok(collideWithArena(kart, arena));
  close(kart.z, 10 - P.radius);
  close(kart.speed, -20 * P.wallBounce);
});

test('scraping along a wall keeps some speed', () => {
  const arena = { halfWidth: 10, halfDepth: 10 };
  const kart = createKart({ x: 9.5, heading: Math.PI / 6 }); // mostly along the wall, a bit into it
  kart.speed = 20;
  collideWithArena(kart, arena);
  assert.ok(kart.speed > 10, `speed after scraping: ${kart.speed}`);
});

test('round obstacles push the kart out', () => {
  const kart = createKart({ x: 0, z: 0.5 });
  kart.speed = 10;
  const cone = { x: 0, z: 1, radius: 0.4 };
  assert.ok(collideWithObstacle(kart, cone));
  close(Math.hypot(kart.x - cone.x, kart.z - cone.z), cone.radius + P.radius);
  assert.ok(kart.speed < 0);
});

test('rear-ending a kart shoves it forward and slows you down', () => {
  const slow = createKart({ z: 1.5 });
  slow.speed = 2;
  const fast = createKart({ z: 0 });
  fast.speed = 15;
  assert.ok(collideKarts(fast, slow));
  assert.ok(slow.speed > 2, `bumped kart speed ${slow.speed}`);
  assert.ok(fast.speed < 15, `bumping kart speed ${fast.speed}`);
  assert.ok(slow.z - fast.z >= 2 * P.radius - 1e-9, 'pushed apart');
});

test('stepWorld moves every kart and reports who hit something', () => {
  const world = {
    karts: new Map([
      [1, createKart({ x: -5 })],
      [2, createKart({ x: 5, z: 9.5 })],
    ]),
    arena: { halfWidth: 10, halfDepth: 10 },
    obstacles: [],
  };
  const hits = stepWorld(world, () => ({ gas: true }), DT);
  assert.ok(world.karts.get(1).speed > 0);
  assert.deepEqual([...hits], [2]);
});

test('interpolation draws between the last two steps, the short way round', () => {
  const kart = createKart();
  kart.prev = { x: 0, z: 0, heading: Math.PI - 0.1 };
  Object.assign(kart, { x: 2, z: 4, heading: -Math.PI + 0.1 });
  const mid = interpolate(kart, 0.5);
  close(mid.x, 1);
  close(mid.z, 2);
  close(Math.abs(mid.heading), Math.PI, 1e-9);
});

test('forwardOf: heading 0 faces +z', () => {
  const f = forwardOf(0);
  close(f.x, 0);
  close(f.z, 1);
});

// ---------- Fixed timestep ----------

test('fixed step: the same number of physics steps whatever the frame rate', () => {
  const stepsInOneSecond = (fps) => {
    let steps = 0;
    const loop = createFixedStep({ stepHz: 120, step: () => steps++ });
    for (let frame = 0; frame < fps; frame++) loop.advance(1000 / fps);
    return steps;
  };
  // One second of play at 30, 60 and 144 fps: 120 steps each (give or take
  // one, since 1000/30 isn't exact in floating point).
  for (const fps of [30, 60, 144]) {
    assert.ok(Math.abs(stepsInOneSecond(fps) - 120) <= 1, `${fps} fps: ${stepsInOneSecond(fps)} steps`);
  }
});

test('fixed step: alpha is the leftover fraction of a step', () => {
  const loop = createFixedStep({ stepHz: 100, step: () => {} });
  const { steps, alpha } = loop.advance(25);
  assert.equal(steps, 2);
  close(alpha, 0.5);
});

test('fixed step: a long pause is capped instead of replayed', () => {
  let steps = 0;
  const loop = createFixedStep({ stepHz: 120, maxStepsPerFrame: 10, step: () => steps++ });
  loop.advance(60_000); // a minute in a background tab
  assert.equal(steps, 10);
});
