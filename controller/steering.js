/**
 * Steering math: phone orientation  ->  steering value in [-1, +1].
 *
 * Pure functions with no browser APIs, so they can be unit-tested in Node
 * (see test/steering.test.js) and reused by the game later.
 *
 * Pipeline (docs/phase-1-steering.md explains each step):
 *
 *   beta, gamma  ->  gravity in phone frame  ->  gravity in screen frame
 *     ->  wheel angle (deg)  ->  minus calibration  ->  smoothing
 *     ->  dead zone  ->  scale + clamp  ->  response curve  ->  steering
 */

const DEG = Math.PI / 180;
const RELEASE_MS = 120; // how quickly steering returns to straight when there's no reading

/** Tunable settings. The controller page exposes each one as a slider. */
export const DEFAULT_SETTINGS = Object.freeze({
  deadZoneDeg: 3, // ignore wobbles smaller than this
  maxAngleDeg: 35, // tilt that gives full lock (±1)
  smoothingMs: 60, // low-pass time constant; 0 = raw
  curve: 0.4, // 0 = linear, 1 = cubic (finer control near centre)
  invert: false,
});

/**
 * Which way is "down" (gravity), expressed in the phone's own axes.
 * Phone axes: x = right edge, y = top edge, z = out of the screen (portrait).
 *
 * DeviceOrientation gives intrinsic Z-X'-Y'' Euler angles (alpha, beta, gamma).
 * Alpha is a compass heading, which a steering wheel doesn't care about,
 * so only beta and gamma are needed:
 *   down = Ry(gamma)^T * Rx(beta)^T * (0, 0, -1)
 */
export function gravityInPhoneFrame(betaDeg, gammaDeg) {
  const b = betaDeg * DEG;
  const g = gammaDeg * DEG;
  return {
    x: Math.cos(b) * Math.sin(g),
    y: -Math.sin(b),
    z: -Math.cos(b) * Math.cos(g),
  };
}

/**
 * Rotate a phone-frame vector into screen axes (x = screen right, y = screen up).
 * screenAngleDeg is screen.orientation.angle: 0 portrait, 90 when the phone is
 * turned counter-clockwise into landscape, 270 (or -90) for clockwise.
 */
export function toScreenFrame(v, screenAngleDeg) {
  const a = screenAngleDeg * DEG;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z };
}

/**
 * The steering-wheel angle: how far the screen is rotated about its own
 * centre, measured from gravity. 0 when the screen's bottom edge faces the
 * floor; positive when the phone is turned clockwise (steer right).
 */
export function wheelAngleDeg(screenGravity) {
  return Math.atan2(screenGravity.x, -screenGravity.y) / DEG;
}

/**
 * How upright the screen is: 1 when held vertical, 0 when lying flat.
 * When flat, gravity points straight through the screen and the wheel angle
 * is meaningless, so the controller holds the last value instead.
 */
export function uprightness(screenGravity) {
  return Math.hypot(screenGravity.x, screenGravity.y);
}

/** Wrap any angle into [-180, 180). */
export function wrapDeg(angle) {
  return ((((angle + 180) % 360) + 360) % 360) - 180;
}

export function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

/** Zero inside ±deadZone, then continue smoothly from zero (no jump at the edge). */
export function applyDeadZone(x, deadZone) {
  const m = Math.abs(x);
  return m <= deadZone ? 0 : Math.sign(x) * (m - deadZone);
}

/**
 * Exponential low-pass weight for a sample arriving dtMs after the last one.
 * Time-based, so it behaves the same at 30 Hz or 120 Hz sensor rates.
 */
export function smoothingWeight(dtMs, timeConstantMs) {
  if (timeConstantMs <= 0) return 1;
  return 1 - Math.exp(-Math.max(0, dtMs) / timeConstantMs);
}

/** Calibrated, smoothed angle (deg)  ->  steering value in [-1, 1]. */
export function shapeSteering(angleDeg, settings) {
  const { deadZoneDeg, maxAngleDeg, curve, invert } = settings;
  const range = Math.max(1e-6, maxAngleDeg - deadZoneDeg);
  const x = clamp(applyDeadZone(angleDeg, deadZoneDeg) / range, -1, 1);
  const shaped = (1 - curve) * x + curve * x * x * x;
  return invert ? -shaped : shaped;
}

/** Phone orientation reading  ->  raw wheel angle, or null when the phone is too flat. */
export function readWheelAngle({ beta, gamma, screenAngleDeg, minUpright = 0.35 }) {
  const screenGravity = toScreenFrame(gravityInPhoneFrame(beta, gamma), screenAngleDeg);
  const upright = uprightness(screenGravity);
  return {
    angleDeg: upright >= minUpright ? wheelAngleDeg(screenGravity) : null,
    upright,
  };
}

/**
 * Holds the state between samples: calibration centre and the smoothed angle.
 * Feed it raw wheel angles with timestamps; read `.value` for steering.
 */
export class SteeringProcessor {
  constructor(settings = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.reset();
  }

  reset() {
    this.centerDeg = null; // set from the first sample, or by recenter()
    this.rawDeg = 0; // latest uncalibrated wheel angle
    this.angleDeg = 0; // calibrated + smoothed angle
    this.value = 0; // final steering in [-1, 1]
    this.lastTimeMs = null;
  }

  setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.value = shapeSteering(this.angleDeg, this.settings);
  }

  /** Treat the current hold as straight ahead. */
  recenter() {
    this.centerDeg = this.rawDeg;
    this.angleDeg = 0;
    this.value = 0;
  }

  update(rawDeg, timeMs) {
    this.rawDeg = rawDeg;
    if (this.centerDeg === null) this.centerDeg = rawDeg;

    const target = wrapDeg(rawDeg - this.centerDeg);
    const dt = this.lastTimeMs === null ? Infinity : timeMs - this.lastTimeMs;
    this.lastTimeMs = timeMs;

    // Step toward the target along the shortest way round the circle.
    const k = smoothingWeight(dt, this.settings.smoothingMs);
    this.angleDeg = wrapDeg(this.angleDeg + k * wrapDeg(target - this.angleDeg));
    this.value = shapeSteering(this.angleDeg, this.settings);
    return this.value;
  }

  /**
   * No usable reading (e.g. the phone is lying flat): let go of the wheel.
   * The steering eases back to straight instead of sticking at its last value.
   */
  release(timeMs) {
    const dt = this.lastTimeMs === null ? Infinity : timeMs - this.lastTimeMs;
    this.lastTimeMs = timeMs;
    const k = smoothingWeight(dt, Math.max(this.settings.smoothingMs, RELEASE_MS));
    this.angleDeg -= k * this.angleDeg;
    this.value = shapeSteering(this.angleDeg, this.settings);
    return this.value;
  }
}
