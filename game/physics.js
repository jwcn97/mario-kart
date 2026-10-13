/**
 * Arcade kart physics. No Three.js, no DOM: plain numbers, so it's unit-tested
 * (test/physics.test.js) and runs the same at any frame rate.
 *
 * Kart racers fake their physics on purpose. Instead of tyre forces we model:
 *   - one number for speed along the kart's nose (negative = reversing)
 *   - pedals that change that speed, plus drag
 *   - a turn rate that needs some speed, and gets a little weaker near top speed
 * The kart always moves the way its nose points (no sliding until drifting in Phase 5).
 *
 * World axes (same as Three.js): x to the right, z towards the camera's start, y up.
 * `heading` is in radians; heading 0 points along +z. Increasing heading turns left.
 */

export const KART_PARAMS = Object.freeze({
  maxSpeed: 24, // m/s forward (~86 km/h)
  maxReverse: 7, // m/s backward
  accel: 14, // m/s² with the gas pressed
  brake: 30, // m/s² braking
  reverseAccel: 9, // m/s² backing up (brake held while stopped)
  coastDrag: 3, // m/s² slowdown with no pedal pressed
  airDrag: 0.012, // extra slowdown that grows with speed²
  maxTurnRate: 2.6, // rad/s at the best speed for turning
  fullTurnSpeed: 6, // m/s needed for full steering (no turning on the spot)
  topSpeedTurnLoss: 0.4, // fraction of turning lost at top speed (gentle understeer)
  offRoadMaxSpeed: 11, // m/s on grass (~40 km/h)
  offRoadDrag: 30, // m/s² slowdown while faster than that on grass (beats the gas)
  radius: 1.1, // m, for collisions
  wallBounce: 0.25, // 0 = stick to the wall, 1 = perfect bounce
  kartBounce: 0.3,
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function createKart({ x = 0, z = 0, heading = 0 } = {}) {
  return { x, z, heading, speed: 0, prev: { x, z, heading } };
}

export const forwardOf = (heading) => ({ x: Math.sin(heading), z: Math.cos(heading) });

/** How much of the steering input turns the kart at this speed (0..1). */
export function turnGrip(speed, p = KART_PARAMS) {
  const s = Math.abs(speed);
  return clamp(s / p.fullTurnSpeed, 0, 1) * (1 - p.topSpeedTurnLoss * clamp(s / p.maxSpeed, 0, 1));
}

/** Pedals and drag -> new speed. Off the road, grass drags you down to a crawl. */
export function nextSpeed(speed, { gas = false, brake = false }, dt, p = KART_PARAMS, offRoad = false) {
  let v = speed;
  if (brake) {
    // Brake while rolling forward; once stopped, holding brake backs up.
    v = v > 0 ? Math.max(0, v - p.brake * dt) : v - p.reverseAccel * dt;
  } else if (gas) {
    // Gas while rolling backward brakes first.
    v += (v < 0 ? p.brake : p.accel) * dt;
  } else {
    const slow = p.coastDrag * dt;
    v = Math.abs(v) <= slow ? 0 : v - Math.sign(v) * slow;
  }
  v -= Math.sign(v) * p.airDrag * v * v * dt;
  v = clamp(v, -p.maxReverse, p.maxSpeed);
  if (offRoad && Math.abs(v) > p.offRoadMaxSpeed) {
    v = Math.sign(v) * Math.max(p.offRoadMaxSpeed, Math.abs(v) - p.offRoadDrag * dt);
  }
  return v;
}

/**
 * One physics step for one kart. `input` is { steer: -1..1, gas, brake }.
 * Steering right (positive) turns clockwise seen from above, so heading goes down.
 * In reverse the turn flips, like a real car backing up.
 */
export function stepKart(kart, input, dt, p = KART_PARAMS, { offRoad = false } = {}) {
  kart.prev.x = kart.x;
  kart.prev.z = kart.z;
  kart.prev.heading = kart.heading;

  kart.speed = nextSpeed(kart.speed, input, dt, p, offRoad);
  const steer = clamp(input.steer ?? 0, -1, 1);
  kart.heading -= steer * p.maxTurnRate * turnGrip(kart.speed, p) * Math.sign(kart.speed) * dt;

  const f = forwardOf(kart.heading);
  kart.x += f.x * kart.speed * dt;
  kart.z += f.z * kart.speed * dt;
}

/**
 * The kart hit something whose surface faces direction n (unit vector, pointing
 * away from the obstacle). Take out the velocity going into it, bounce a bit,
 * and keep what's left along the kart's nose.
 */
export function bounceOff(kart, nx, nz, bounce) {
  const f = forwardOf(kart.heading);
  let vx = f.x * kart.speed;
  let vz = f.z * kart.speed;
  const into = vx * nx + vz * nz;
  if (into >= 0) return; // already moving away
  vx -= (1 + bounce) * into * nx;
  vz -= (1 + bounce) * into * nz;
  kart.speed = vx * f.x + vz * f.z;
}

/**
 * Keep the kart between the tyre walls on either side of the track.
 * `where` is track.locate() for the kart's position: how far it is from the
 * centre line (`lateral`, + = right) and how far out each wall is there.
 */
export function collideWithBarriers(kart, where, p = KART_PARAMS) {
  const maxRight = where.barrierRight - p.radius;
  const maxLeft = where.barrierLeft - p.radius;
  if (where.lateral > maxRight) {
    const push = where.lateral - maxRight;
    kart.x -= where.rx * push;
    kart.z -= where.rz * push;
    bounceOff(kart, -where.rx, -where.rz, p.wallBounce); // the wall faces back towards the road
    return true;
  }
  if (where.lateral < -maxLeft) {
    const push = -maxLeft - where.lateral;
    kart.x += where.rx * push;
    kart.z += where.rz * push;
    bounceOff(kart, where.rx, where.rz, p.wallBounce);
    return true;
  }
  return false;
}

/** Round obstacles (cones, crates, trees): { x, z, radius }. */
export function collideWithObstacle(kart, obstacle, p = KART_PARAMS) {
  const dx = kart.x - obstacle.x;
  const dz = kart.z - obstacle.z;
  const minDist = obstacle.radius + p.radius;
  const distSq = dx * dx + dz * dz;
  if (distSq >= minDist * minDist) return false;
  const dist = Math.sqrt(distSq) || 1e-6;
  const nx = dist > 1e-6 ? dx / dist : 1;
  const nz = dist > 1e-6 ? dz / dist : 0;
  kart.x = obstacle.x + nx * minDist;
  kart.z = obstacle.z + nz * minDist;
  bounceOff(kart, nx, nz, p.wallBounce);
  return true;
}

/**
 * Two karts touching: push them apart and swap some momentum along the line
 * between them (equal masses), so bumping someone from behind shoves them forward.
 */
export function collideKarts(a, b, p = KART_PARAMS) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const minDist = 2 * p.radius;
  const distSq = dx * dx + dz * dz;
  if (distSq >= minDist * minDist) return false;
  const dist = Math.sqrt(distSq);
  const nx = dist > 1e-6 ? dx / dist : 1; // from a towards b
  const nz = dist > 1e-6 ? dz / dist : 0;

  const overlap = minDist - dist;
  a.x -= (nx * overlap) / 2;
  a.z -= (nz * overlap) / 2;
  b.x += (nx * overlap) / 2;
  b.z += (nz * overlap) / 2;

  const fa = forwardOf(a.heading);
  const fb = forwardOf(b.heading);
  const va = { x: fa.x * a.speed, z: fa.z * a.speed };
  const vb = { x: fb.x * b.speed, z: fb.z * b.speed };
  const closing = (vb.x - va.x) * nx + (vb.z - va.z) * nz;
  if (closing < 0) {
    const j = (-(1 + p.kartBounce) * closing) / 2;
    va.x -= j * nx;
    va.z -= j * nz;
    vb.x += j * nx;
    vb.z += j * nz;
    a.speed = va.x * fa.x + va.z * fa.z;
    b.speed = vb.x * fb.x + vb.z * fb.z;
  }
  return true;
}

/**
 * Advance the whole world by one fixed step.
 * `world` = { karts: Map<slot, kart>, track, obstacles }, `inputFor(slot)` -> input.
 * Each kart remembers where it is on the track (`kart.where`), which the race
 * rules read too. Returns the slots that hit something this step.
 */
export function stepWorld(world, inputFor, dt, p = KART_PARAMS) {
  const hits = new Set();
  const { track } = world;
  for (const [slot, kart] of world.karts) {
    const before = track.locate(kart.x, kart.z, kart.where?.index ?? null);
    stepKart(kart, inputFor(slot), dt, p, { offRoad: track.isOffRoad(before.lateral) });

    let where = track.locate(kart.x, kart.z, before.index);
    if (collideWithBarriers(kart, where, p)) {
      hits.add(slot);
      where = track.locate(kart.x, kart.z, where.index);
    }
    kart.where = where;
    kart.offRoad = track.isOffRoad(where.lateral);

    for (const obstacle of world.obstacles ?? []) {
      if (collideWithObstacle(kart, obstacle, p)) hits.add(slot);
    }
  }
  const list = [...world.karts.entries()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (collideKarts(list[i][1], list[j][1], p)) {
        hits.add(list[i][0]);
        hits.add(list[j][0]);
      }
    }
  }
  return hits;
}

/** Where to draw a kart between the last two physics steps (alpha 0..1). */
export function interpolate(kart, alpha) {
  const t = clamp(alpha, 0, 1);
  let dh = kart.heading - kart.prev.heading;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh)); // shortest way round
  return {
    x: kart.prev.x + (kart.x - kart.prev.x) * t,
    z: kart.prev.z + (kart.z - kart.prev.z) * t,
    heading: kart.prev.heading + dh * t,
  };
}
