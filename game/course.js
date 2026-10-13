/**
 * The Phase 3 playground: a walled square of asphalt with things to drive around.
 * Plain data, shared by the physics (collisions) and the 3D scene (drawing).
 * Phase 4 replaces this with a real track.
 */

export const ARENA = Object.freeze({ halfWidth: 60, halfDepth: 60 });

/** Starting grid: four places side by side near the south wall, facing north (-z). */
const START_Z = 42;
const START_HEADING = Math.PI;
export const START_LINE_Z = START_Z - 4;

export function startPosition(slot) {
  const lane = [-6, -2, 2, 6][(slot - 1) % 4];
  return { x: lane, z: START_Z, heading: START_HEADING };
}

/** Round things to steer around: { kind, x, z, radius }. */
export const OBSTACLES = Object.freeze([
  // A slalom down the middle.
  ...[-28, -20, -12, -4, 4, 12, 20].map((z, i) => ({ kind: 'cone', x: i % 2 ? 3 : -3, z, radius: 0.4 })),
  // A ring of cones to circle around, east side.
  ...Array.from({ length: 10 }, (_, i) => {
    const a = (i / 10) * Math.PI * 2;
    return { kind: 'cone', x: 32 + Math.cos(a) * 8, z: -4 + Math.sin(a) * 8, radius: 0.4 };
  }),
  // Crates.
  { kind: 'crate', x: -30, z: 14, radius: 1.3 },
  { kind: 'crate', x: -34, z: 18, radius: 1.3 },
  { kind: 'crate', x: -26, z: -32, radius: 1.3 },
  { kind: 'crate', x: 22, z: 30, radius: 1.3 },
  // Trees in the corners.
  { kind: 'tree', x: -48, z: -48, radius: 1.2 },
  { kind: 'tree', x: 48, z: -48, radius: 1.2 },
  { kind: 'tree', x: -48, z: 48, radius: 1.2 },
  { kind: 'tree', x: 48, z: 48, radius: 1.2 },
  { kind: 'tree', x: -42, z: -20, radius: 1.2 },
  { kind: 'tree', x: 44, z: -34, radius: 1.2 },
]);
