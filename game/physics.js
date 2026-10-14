/**
 * Arcade kart physics. No Three.js, no DOM: plain numbers, so it's unit-tested
 * (test/physics.test.js) and runs the same at any frame rate.
 *
 * Kart racers fake their physics on purpose. Instead of tyre forces we model:
 *   - one number for speed along the kart's nose (negative = reversing)
 *   - pedals that change that speed, plus drag
 *   - a turn rate that needs some speed, and gets a little weaker near top speed
 * The kart always moves the way its nose points.
 *
 * Phase 5 adds the fun parts, all still plain numbers:
 *   - drifting: hold drift while steering to lock into a tighter, sliding turn;
 *     the longer you hold it, the bigger the mini-turbo when you let go
 *   - boost: a few seconds of higher top speed (mini-turbos, boost pads)
 *   - jumps: height (y) and vertical speed, so ramps launch you
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

  // Drifting (Phase 5)
  driftMinSpeed: 8, // m/s needed to start (and keep) a drift
  driftStartSteer: 0.25, // how far you must be steering when you press drift
  driftTurnOut: 0.45, // turn rate (× maxTurnRate) when steering against the drift: wide
  driftTurnIn: 1.2, // ...and when steering into it: tight
  driftDrag: 1.5, // m/s² lost while drifting
  driftLevel1: 0.9, // s of drifting for a blue mini-turbo
  driftLevel2: 2.0, // s of drifting for an orange one
  miniTurbo1: 0.6, // s of boost from a blue mini-turbo
  miniTurbo2: 1.2, // s of boost from an orange one

  // Boost (Phase 5)
  boostSpeed: 31, // m/s top speed while boosting (~112 km/h)
  boostAccel: 30, // m/s² extra push while boosting
  overSpeedDrag: 10, // m/s² back down to normal top speed when a boost ends
  padBoost: 1.2, // s of boost from a boost pad

  // Jumps (Phase 5)
  gravity: 22, // m/s² (heavier than real: arcade jumps feel snappier)
  airSteer: 0.3, // fraction of steering that still works in the air
});

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function createKart({ x = 0, z = 0, heading = 0 } = {}) {
  return {
    x,
    z,
    heading,
    speed: 0,
    y: 0, // height above the ground (jumps)
    vy: 0, // vertical speed
    airborne: false,
    climb: 0, // vertical speed while driving up a ramp, kept for the launch
    drift: { dir: 0, time: 0, level: 0 }, // dir: 0 = not drifting, +1 = right, -1 = left
    boost: 0, // seconds of boost left
    padCooldown: 0, // so one pad gives one boost
    prev: { x, z, heading, y: 0 },
  };
}

export const forwardOf = (heading) => ({ x: Math.sin(heading), z: Math.cos(heading) });

/** How much of the steering input turns the kart at this speed (0..1). */
export function turnGrip(speed, p = KART_PARAMS) {
  const s = Math.abs(speed);
  return clamp(s / p.fullTurnSpeed, 0, 1) * (1 - p.topSpeedTurnLoss * clamp(s / p.maxSpeed, 0, 1));
}

/**
 * Pedals and drag -> new speed. Off the road, grass drags you down to a crawl.
 * While boosting, top speed rises and grass doesn't slow you; after a boost the
 * extra speed bleeds off gradually instead of snapping back.
 */
export function nextSpeed(
  speed,
  { gas = false, brake = false },
  dt,
  p = KART_PARAMS,
  { offRoad = false, boosting = false, airborne = false, drifting = false } = {},
) {
  let v = speed;
  if (airborne) {
    // In the air the pedals do nothing; only air drag.
  } else if (brake) {
    // Brake while rolling forward; once stopped, holding brake backs up.
    v = v > 0 ? Math.max(0, v - p.brake * dt) : v - p.reverseAccel * dt;
  } else if (gas) {
    // Gas while rolling backward brakes first.
    v += (v < 0 ? p.brake : p.accel) * dt;
  } else {
    const slow = p.coastDrag * dt;
    v = Math.abs(v) <= slow ? 0 : v - Math.sign(v) * slow;
  }
  if (boosting && !airborne) v += p.boostAccel * dt;
  if (drifting) v -= p.driftDrag * dt;
  v -= Math.sign(v) * p.airDrag * v * v * dt;

  const top = boosting ? p.boostSpeed : p.maxSpeed;
  if (v > top) v = boosting ? top : Math.max(top, v - p.overSpeedDrag * dt);
  v = Math.max(v, -p.maxReverse);

  if (offRoad && !boosting && !airborne && Math.abs(v) > p.offRoadMaxSpeed) {
    v = Math.sign(v) * Math.max(p.offRoadMaxSpeed, Math.abs(v) - p.offRoadDrag * dt);
  }
  return v;
}

/**
 * Drift state for one step. Returns an event name or null.
 *
 *   press drift while steering at speed  ->  drift locks in that direction
 *   keep holding                         ->  charge: blue at 0.9 s, orange at 2 s
 *   let go                               ->  mini-turbo (if charged)
 *   too slow                             ->  drift ends, no reward
 */
export function updateDrift(kart, input, dt, p = KART_PARAMS, { offRoad = false } = {}) {
  const d = kart.drift;
  const steer = clamp(input.steer ?? 0, -1, 1);

  if (d.dir === 0) {
    const canStart = input.drift && !kart.airborne && kart.speed > p.driftMinSpeed && Math.abs(steer) > p.driftStartSteer;
    if (!canStart) return null;
    Object.assign(d, { dir: Math.sign(steer), time: 0, level: 0 });
    return 'drift-start';
  }

  if (!input.drift) {
    const level = d.level;
    Object.assign(d, { dir: 0, time: 0, level: 0 });
    if (level === 0) return 'drift-end';
    kart.boost = Math.max(kart.boost, level === 2 ? p.miniTurbo2 : p.miniTurbo1);
    return `mini-turbo-${level}`;
  }

  if (kart.speed < p.driftMinSpeed * 0.6) {
    cancelDrift(kart);
    return 'drift-end';
  }

  // Charge only while actually sliding on the road.
  if (!kart.airborne && !offRoad) d.time += dt;
  const level = d.time >= p.driftLevel2 ? 2 : d.time >= p.driftLevel1 ? 1 : 0;
  if (level > d.level) {
    d.level = level;
    return `drift-level-${level}`;
  }
  return null;
}

/** End a drift with no mini-turbo (hit a wall, too slow). */
export function cancelDrift(kart) {
  Object.assign(kart.drift, { dir: 0, time: 0, level: 0 });
}

/**
 * One physics step for one kart (horizontal movement). `input` is
 * { steer: -1..1, gas, brake, drift }. Returns a drift event name or null.
 *
 * Steering right (positive) turns clockwise seen from above, so heading goes down.
 * In reverse the turn flips, like a real car backing up. While drifting the kart
 * always turns in the drift's direction: steering only makes it tighter or wider.
 */
export function stepKart(kart, input, dt, p = KART_PARAMS, { offRoad = false } = {}) {
  kart.prev.x = kart.x;
  kart.prev.z = kart.z;
  kart.prev.heading = kart.heading;
  kart.prev.y = kart.y;

  const driftEvent = updateDrift(kart, input, dt, p, { offRoad });
  const drifting = kart.drift.dir !== 0;
  const boosting = kart.boost > 0;
  kart.boost = Math.max(0, kart.boost - dt);
  kart.padCooldown = Math.max(0, kart.padCooldown - dt);

  kart.speed = nextSpeed(kart.speed, input, dt, p, { offRoad, boosting, airborne: kart.airborne, drifting });

  const steer = clamp(input.steer ?? 0, -1, 1);
  let turn; // rad/s, positive = right
  if (drifting) {
    const into = (steer * kart.drift.dir + 1) / 2; // 0 = steering out of the drift, 1 = into it
    turn = kart.drift.dir * p.maxTurnRate * (p.driftTurnOut + (p.driftTurnIn - p.driftTurnOut) * into);
  } else {
    turn = steer * p.maxTurnRate * turnGrip(kart.speed, p) * Math.sign(kart.speed);
  }
  if (kart.airborne) turn *= p.airSteer;
  kart.heading -= turn * dt;

  const f = forwardOf(kart.heading);
  kart.x += f.x * kart.speed * dt;
  kart.z += f.z * kart.speed * dt;
  return driftEvent;
}

/**
 * Up and down: follow the ground (flat, or a ramp's slope); fly off the end
 * of a ramp with the vertical speed you had climbing it; land when you reach
 * the ground again. Returns 'jump', 'land' or null.
 */
export function stepVertical(kart, groundY, dt, p = KART_PARAMS) {
  if (kart.airborne) {
    kart.vy -= p.gravity * dt;
    kart.y += kart.vy * dt;
    if (kart.y <= groundY) {
      kart.y = groundY;
      kart.vy = 0;
      kart.airborne = false;
      return 'land';
    }
    return null;
  }
  if (kart.y - groundY > 0.15) {
    // The ground dropped away under us: the end of a ramp.
    kart.airborne = true;
    kart.vy = Math.max(kart.climb, 0);
    kart.climb = 0;
    return kart.vy > 0.5 ? 'jump' : null;
  }
  kart.climb = (groundY - kart.y) / dt;
  kart.y = groundY;
  return null;
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
 * rules read too.
 *
 * Returns events for effects and phone vibration:
 *   { slot, type: 'hit' | 'bump' | 'boost-pad' | 'jump' | 'land' | 'drift-start' |
 *     'drift-level-1' | 'drift-level-2' | 'mini-turbo-1' | 'mini-turbo-2' | 'drift-end', strength? }
 */
export function stepWorld(world, inputFor, dt, p = KART_PARAMS) {
  const events = [];
  const { track } = world;
  for (const [slot, kart] of world.karts) {
    const before = track.locate(kart.x, kart.z, kart.where?.index ?? null);
    const driftEvent = stepKart(kart, inputFor(slot), dt, p, { offRoad: track.isOffRoad(before.lateral) });
    if (driftEvent) events.push({ slot, type: driftEvent });

    let where = track.locate(kart.x, kart.z, before.index);
    const speedBefore = kart.speed;
    if (collideWithBarriers(kart, where, p)) {
      events.push({ slot, type: 'hit', strength: Math.abs(speedBefore - kart.speed) });
      if (kart.drift.dir !== 0) cancelDrift(kart); // a wall ends a drift, no mini-turbo
      where = track.locate(kart.x, kart.z, where.index);
    }
    kart.where = where;
    kart.offRoad = track.isOffRoad(where.lateral);

    const vertical = stepVertical(kart, track.groundHeight(where), dt, p);
    if (vertical) events.push({ slot, type: vertical });

    if (!kart.airborne && kart.padCooldown === 0 && track.boostPadAt(where)) {
      kart.boost = Math.max(kart.boost, p.padBoost);
      kart.speed = Math.max(kart.speed, p.maxSpeed);
      kart.padCooldown = 0.5;
      events.push({ slot, type: 'boost-pad' });
    }

    for (const obstacle of world.obstacles ?? []) {
      if (collideWithObstacle(kart, obstacle, p)) events.push({ slot, type: 'hit', strength: 5 });
    }
  }
  const list = [...world.karts.entries()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const [slotA, a] = list[i];
      const [slotB, b] = list[j];
      if (Math.abs(a.y - b.y) > 1.2) continue; // one is flying over the other
      const speedA = a.speed;
      if (collideKarts(a, b, p)) {
        const strength = Math.abs(speedA - a.speed);
        events.push({ slot: slotA, type: 'bump', strength }, { slot: slotB, type: 'bump', strength });
      }
    }
  }
  return events;
}

/** Where to draw a kart between the last two physics steps (alpha 0..1). */
export function interpolate(kart, alpha) {
  const t = clamp(alpha, 0, 1);
  let dh = kart.heading - kart.prev.heading;
  dh = Math.atan2(Math.sin(dh), Math.cos(dh)); // shortest way round
  return {
    x: kart.prev.x + (kart.x - kart.prev.x) * t,
    z: kart.prev.z + (kart.z - kart.prev.z) * t,
    y: (kart.prev.y ?? 0) + ((kart.y ?? 0) - (kart.prev.y ?? 0)) * t,
    heading: kart.prev.heading + dh * t,
  };
}
