/**
 * Track geometry: a closed loop through a list of control points.
 * Pure math, no Three.js: physics, race rules, the 3D scene and the minimap all
 * use the same samples, and the tests check it with plain numbers.
 *
 *   control points ─► Catmull-Rom spline ─► resampled every ~1 m along its length
 *
 * Each sample knows its distance along the track (`s`), the direction of travel
 * (`tx`, `tz`) and which way is "right" (`rx`, `rz`). From those, `locate()` turns
 * any kart position into "how far round the lap" and "how far off the centre line".
 */

/** The circuit. Driven in the order of these points; the first one is the finish line. */
export const TRACK_LAYOUT = Object.freeze({
  name: 'Kerb Valley',
  points: [
    [20, 90], // start/finish, on the main straight heading west
    [-50, 92],
    [-105, 78],
    [-130, 35],
    [-115, -5],
    [-80, -28], // west esses
    [-85, -68],
    [-115, -92],
    [-108, -124],
    [-72, -136],
    [-10, -125], // back straight heading east
    [60, -130],
    [112, -105],
    [128, -58],
    [100, -22], // east esses
    [62, -4],
    [70, 38],
    [112, 58],
    [105, 95],
    [60, 97],
  ],
  // Things on the road (Phase 5). `near` is any point close to where it goes;
  // it's snapped onto the track when the track is built. `lateral`: + = right.
  features: [
    { type: 'boost', near: [-50, -133], lateral: -3, length: 6, width: 4 }, // back straight, left lane
    { type: 'ramp', near: [9, -126], length: 8, height: 1.4 }, // full width, just after that pad
    { type: 'boost', near: [80, 96], lateral: 3, length: 6, width: 4 }, // main straight, right lane
  ],
  roadHalfWidth: 7, // m from the centre line to the road edge
  kerbWidth: 1.2, // red-and-white strip just outside the road (still counts as road)
  barrierOffset: 16, // m from the centre line to the tyre wall
  spacing: 1, // m between samples
});

// ---------- Spline ----------

/**
 * Centripetal Catmull-Rom between p1 and p2 (Barry & Goldman's formulation).
 * "Centripetal" spaces the curve by the square root of the distance between
 * points, which avoids loops and cusps when control points are unevenly spaced.
 */
function catmullRom(p0, p1, p2, p3, u) {
  const knot = (a, b) => Math.max(Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5, 1e-6);
  const t0 = 0;
  const t1 = t0 + knot(p0, p1);
  const t2 = t1 + knot(p1, p2);
  const t3 = t2 + knot(p2, p3);
  const t = t1 + (t2 - t1) * u;
  const lerp = (a, b, ta, tb) => [
    ((tb - t) / (tb - ta)) * a[0] + ((t - ta) / (tb - ta)) * b[0],
    ((tb - t) / (tb - ta)) * a[1] + ((t - ta) / (tb - ta)) * b[1],
  ];
  const a1 = lerp(p0, p1, t0, t1);
  const a2 = lerp(p1, p2, t1, t2);
  const a3 = lerp(p2, p3, t2, t3);
  const b1 = lerp(a1, a2, t0, t2);
  const b2 = lerp(a2, a3, t1, t3);
  return lerp(b1, b2, t1, t2);
}

/** Wrap a distance difference into [-L/2, L/2): "how far, the short way round the loop". */
export function wrapDelta(delta, length) {
  return ((((delta + length / 2) % length) + length) % length) - length / 2;
}

// ---------- Build ----------

export function buildTrack(layout = TRACK_LAYOUT) {
  const pts = layout.points;
  const n = pts.length;

  // 1. Dense points along the spline (closed: indices wrap round).
  const dense = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    for (let k = 0; k < 60; k++) dense.push(catmullRom(p0, p1, p2, p3, k / 60));
  }

  // 2. Measure it, then resample at even spacing, so "s" is true distance along the road.
  const cumulative = [0];
  for (let i = 1; i <= dense.length; i++) {
    const a = dense[i - 1];
    const b = dense[i % dense.length];
    cumulative.push(cumulative[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  const length = cumulative[dense.length];
  const count = Math.round(length / layout.spacing);
  const step = length / count;

  const samples = [];
  let j = 0;
  for (let i = 0; i < count; i++) {
    const s = i * step;
    while (cumulative[j + 1] < s) j++;
    const a = dense[j];
    const b = dense[(j + 1) % dense.length];
    const f = (s - cumulative[j]) / (cumulative[j + 1] - cumulative[j]);
    samples.push({ x: a[0] + (b[0] - a[0]) * f, z: a[1] + (b[1] - a[1]) * f, s });
  }

  // 3. Direction of travel and "right" at each sample. Measured over ±4 m rather
  //    than to the next sample: the spline has tiny kinks at each control point,
  //    and a wider look smooths them out of the road edges and walls.
  for (let i = 0; i < count; i++) {
    const prev = samples[(i - 4 + count) % count];
    const next = samples[(i + 4) % count];
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const len = Math.hypot(dx, dz);
    const sample = samples[i];
    sample.tx = dx / len;
    sample.tz = dz / len;
    // Right of travel (as the driver sees it), matching physics.js: right = (-fz, fx).
    sample.rx = -sample.tz;
    sample.rz = sample.tx;
  }

  // 4. How far out the barriers are on each side. On the inside of a tight
  //    corner, a wall 16 m out would fold over itself, so it comes in to just
  //    inside the corner's radius. Then smooth it so the wall has no kinks.
  const reach = 5; // samples either side for measuring the bend
  const inner = [];
  for (let i = 0; i < count; i++) {
    const a = samples[(i - reach + count) % count];
    const b = samples[(i + reach) % count];
    const turn = Math.asin(Math.max(-1, Math.min(1, a.tx * b.tz - a.tz * b.tx))); // >0: bending right
    const radius = Math.abs(turn) > 1e-6 ? (2 * reach * step) / Math.abs(turn) : Infinity;
    const insideLimit = Math.min(layout.barrierOffset, radius * 0.8);
    inner.push({ right: turn > 0 ? insideLimit : layout.barrierOffset, left: turn < 0 ? insideLimit : layout.barrierOffset });
  }
  const smoothSide = (side) => {
    // Running minimum (so the wall starts coming in before the corner), then a running average.
    const mins = inner.map((_, i) => {
      let m = Infinity;
      for (let k = -10; k <= 10; k++) m = Math.min(m, inner[(i + k + count) % count][side]);
      return m;
    });
    return mins.map((_, i) => {
      let sum = 0;
      for (let k = -6; k <= 6; k++) sum += mins[(i + k + count) % count];
      return sum / 13;
    });
  };
  const rights = smoothSide('right');
  const lefts = smoothSide('left');
  samples.forEach((sample, i) => {
    sample.barrierRight = rights[i];
    sample.barrierLeft = lefts[i];
  });

  return new Track(layout, samples, length, step);
}

// ---------- Queries ----------

export class Track {
  constructor(layout, samples, length, step) {
    this.layout = layout;
    this.name = layout.name;
    this.samples = samples;
    this.length = length;
    this.step = step;
    this.roadHalfWidth = layout.roadHalfWidth;
    this.kerbWidth = layout.kerbWidth;
    this.barrierOffset = layout.barrierOffset;

    // Features: snap each onto the track by its `near` point.
    this.features = (layout.features ?? []).map((f) => {
      const where = this.locate(f.near[0], f.near[1]);
      return {
        type: f.type,
        s: where.s,
        length: f.length,
        lateral: f.lateral ?? 0,
        halfWidth: f.width ? f.width / 2 : this.roadHalfWidth + this.kerbWidth,
        height: f.height ?? 0,
      };
    });

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of samples) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z);
      maxZ = Math.max(maxZ, p.z);
    }
    this.bounds = { minX, maxX, minZ, maxZ };
  }

  sample(i) {
    const n = this.samples.length;
    return this.samples[((i % n) + n) % n];
  }

  /**
   * Where is (x, z) relative to the track?
   * `hint` = the sample index from last time. With a hint, only nearby samples
   * are searched (±12 m): fast, and the answer can never jump to another part of
   * the track that happens to be close across the grass.
   *
   * Returns { index, s, lateral, tx, tz, rx, rz, barrierLeft, barrierRight }:
   *   s        distance along the lap, 0 at the finish line
   *   lateral  distance from the centre line, positive to the right
   */
  locate(x, z, hint = null, window = 12) {
    const n = this.samples.length;
    let best = -1;
    let bestDist = Infinity;
    const from = hint === null ? 0 : hint - window;
    const to = hint === null ? n - 1 : hint + window;
    for (let i = from; i <= to; i++) {
      const p = this.sample(i);
      const d = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = ((i % n) + n) % n;
      }
    }

    // Refine between the nearest sample and its neighbours, so s is smooth, not 1 m steps.
    const c = this.samples[best];
    const along = (x - c.x) * c.tx + (z - c.z) * c.tz;
    const s = (c.s + along + this.length) % this.length;
    const lateral = (x - c.x) * c.rx + (z - c.z) * c.rz;
    return {
      index: best,
      s,
      lateral,
      tx: c.tx,
      tz: c.tz,
      rx: c.rx,
      rz: c.rz,
      barrierLeft: c.barrierLeft, // distance to the wall on the left (positive number)
      barrierRight: c.barrierRight,
    };
  }

  /** Point, direction and heading at distance s along the lap. */
  pointAt(s) {
    const n = this.samples.length;
    const wrapped = ((s % this.length) + this.length) % this.length;
    const i = Math.floor(wrapped / this.step);
    const a = this.samples[i % n];
    const b = this.samples[(i + 1) % n];
    const f = wrapped / this.step - i;
    const tx = a.tx + (b.tx - a.tx) * f;
    const tz = a.tz + (b.tz - a.tz) * f;
    const len = Math.hypot(tx, tz);
    return {
      x: a.x + (b.x - a.x) * f,
      z: a.z + (b.z - a.z) * f,
      tx: tx / len,
      tz: tz / len,
      rx: -tz / len,
      rz: tx / len,
      heading: Math.atan2(tx, tz), // physics.js: heading 0 faces +z, forward = (sin, cos)
    };
  }

  /** Starting grid: staggered pairs behind the finish line. */
  gridPosition(slot) {
    const rows = [
      { back: 7, side: -3.2 },
      { back: 11, side: 3.2 },
      { back: 15, side: -3.2 },
      { back: 19, side: 3.2 },
    ];
    const { back, side } = rows[(slot - 1) % rows.length];
    const p = this.pointAt(this.length - back);
    return { x: p.x + p.rx * side, z: p.z + p.rz * side, heading: p.heading };
  }

  /** Is the located point on this feature's patch of road? Returns how far along it (0..1), or null. */
  #on(feature, where) {
    const along = wrapDelta(where.s - feature.s, this.length);
    if (along < 0 || along > feature.length) return null;
    if (Math.abs(where.lateral - feature.lateral) > feature.halfWidth) return null;
    return along / feature.length;
  }

  /** Height of the ground here: 0, or partway up a ramp. */
  groundHeight(where) {
    for (const f of this.features) {
      if (f.type !== 'ramp') continue;
      const t = this.#on(f, where);
      if (t !== null) return f.height * t;
    }
    return 0;
  }

  /** The boost pad under this point, if any. */
  boostPadAt(where) {
    return this.features.find((f) => f.type === 'boost' && this.#on(f, where) !== null) ?? null;
  }

  /** Is this lateral offset off the road (past the kerbs)? */
  isOffRoad(lateral) {
    return Math.abs(lateral) > this.roadHalfWidth + this.kerbWidth;
  }
}
