/**
 * Everything you see on the game screen: the Three.js scene, karts, and cameras.
 * It draws what the physics says; it never decides where anything goes.
 *
 * Three.js basics used here:
 *   renderer  draws the scene into a <canvas> with WebGL
 *   scene     the tree of everything to draw
 *   camera    where we look from (a PerspectiveCamera, like an eye)
 *   mesh      geometry (shape) + material (how its surface reacts to light)
 *   lights    a hemisphere light for soft sky/ground fill, a sun that casts shadows
 */
import * as THREE from 'three';
import { forwardOf } from './physics.js';
import { ARENA, OBSTACLES, START_LINE_Z } from './course.js';

const SKY = 0x8fd0f5;
const WALL_HEIGHT = 1.1;
const WHEEL_RADIUS = 0.34;

/** 1 - e^(-rate·dt): frame-rate independent smoothing for lerp. */
const smooth = (rate, dt) => 1 - Math.exp(-rate * dt);

export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 110, 280);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
    this.camera.position.set(0, 60, 95);
    this.lookAt = new THREE.Vector3(0, 0, 0);

    this.karts = new Map(); // slot -> { group, wheels, frontPivots, tag }
    this.cameraMode = 'auto'; // 'auto' | 'group' | slot number (chase that kart)

    this.#addLights();
    this.#addGround();
    this.#addWalls();
    this.#addObstacles();
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  // ---------- Static scenery ----------

  #addLights() {
    this.scene.add(new THREE.HemisphereLight(0xdff3ff, 0x4d6b3c, 1.4));

    const sun = new THREE.DirectionalLight(0xfff2dc, 2.2);
    sun.position.set(-40, 80, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = ARENA.halfWidth + 10;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 10, far: 220 });
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);
  }

  #addGround() {
    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(600, 600),
      new THREE.MeshStandardMaterial({ color: 0x67a84e, roughness: 1 }),
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.y = -0.02;
    grass.receiveShadow = true;
    this.scene.add(grass);

    const asphalt = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA.halfWidth * 2, ARENA.halfDepth * 2),
      new THREE.MeshStandardMaterial({ map: asphaltTexture(), roughness: 0.95 }),
    );
    asphalt.rotation.x = -Math.PI / 2;
    asphalt.receiveShadow = true;
    this.scene.add(asphalt);

    // Chequered start line across the grid.
    const start = new THREE.Mesh(
      new THREE.PlaneGeometry(24, 2),
      new THREE.MeshStandardMaterial({ map: checkerTexture(12, 1), roughness: 0.8 }),
    );
    start.rotation.x = -Math.PI / 2;
    start.position.set(0, 0.01, START_LINE_Z);
    start.receiveShadow = true;
    this.scene.add(start);
  }

  #addWalls() {
    const material = new THREE.MeshStandardMaterial({ map: kerbTexture(), roughness: 0.7 });
    const t = 1; // thickness
    const w = ARENA.halfWidth;
    const d = ARENA.halfDepth;
    const walls = [
      { x: 0, z: -d - t / 2, sx: 2 * w + 2 * t, sz: t },
      { x: 0, z: d + t / 2, sx: 2 * w + 2 * t, sz: t },
      { x: -w - t / 2, z: 0, sx: t, sz: 2 * d },
      { x: w + t / 2, z: 0, sx: t, sz: 2 * d },
    ];
    for (const wall of walls) {
      const geometry = new THREE.BoxGeometry(wall.sx, WALL_HEIGHT, wall.sz);
      const mat = material.clone();
      mat.map = material.map.clone();
      mat.map.repeat.set(Math.max(wall.sx, wall.sz) / 4, 1);
      mat.map.needsUpdate = true;
      const mesh = new THREE.Mesh(geometry, mat);
      mesh.position.set(wall.x, WALL_HEIGHT / 2, wall.z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  }

  #addObstacles() {
    const make = { cone: makeCone, crate: makeCrate, tree: makeTree };
    for (const o of OBSTACLES) {
      const mesh = make[o.kind]();
      mesh.position.set(o.x, 0, o.z);
      mesh.rotation.y = (o.x * 7 + o.z * 3) % Math.PI; // a little variety, same every time
      this.scene.add(mesh);
    }
  }

  // ---------- Karts ----------

  addKart(slot, { color, name }) {
    if (this.karts.has(slot)) return;
    const kart = makeKart(color);
    kart.tag = makeNameTag(name, color);
    kart.tag.position.set(0, 2.7, 0);
    kart.group.add(kart.tag);
    this.scene.add(kart.group);
    this.karts.set(slot, kart);
  }

  removeKart(slot) {
    const kart = this.karts.get(slot);
    if (!kart) return;
    this.scene.remove(kart.group);
    this.karts.delete(slot);
  }

  /** Move a kart's model to the pose physics computed. */
  updateKart(slot, { x, z, heading }, speed, steer, dt) {
    const kart = this.karts.get(slot);
    if (!kart) return;
    kart.group.position.set(x, 0, z);
    kart.group.rotation.y = heading;
    kart.speed = speed;
    kart.heading = heading;
    // Wheels roll with speed; front wheels turn with steering (right = negative yaw).
    for (const wheel of kart.wheels) wheel.rotation.x += (speed * dt) / WHEEL_RADIUS;
    for (const pivot of kart.frontPivots) pivot.rotation.y = -steer * 0.45;
    // Lean the body a little into turns at speed: cheap, but it sells the motion.
    kart.body.rotation.z = THREE.MathUtils.lerp(kart.body.rotation.z, steer * Math.min(Math.abs(speed) / 24, 1) * 0.08, smooth(10, dt));
  }

  // ---------- Cameras ----------

  /** Cycle: auto -> group -> chase each kart -> auto. Returns a label for the HUD. */
  cycleCamera() {
    const order = ['auto', 'group', ...[...this.karts.keys()].sort()];
    const i = order.indexOf(this.cameraMode);
    this.cameraMode = order[(i + 1) % order.length];
    return this.cameraLabel();
  }

  cameraLabel() {
    if (this.cameraMode === 'auto') return 'auto camera';
    if (this.cameraMode === 'group') return 'group camera';
    return `chasing P${this.cameraMode}`;
  }

  updateCamera(dt, time) {
    const karts = [...this.karts.values()];
    let mode = this.cameraMode;
    if (typeof mode === 'number' && !this.karts.has(mode)) mode = 'auto';
    if (mode === 'auto') mode = karts.length === 1 ? 'chase-only' : karts.length > 1 ? 'group' : 'overview';

    const desired = new THREE.Vector3();
    const target = new THREE.Vector3();

    if (mode === 'overview') {
      // Nobody here yet: slowly circle the arena.
      const a = time * 0.05;
      desired.set(Math.sin(a) * 85, 55, Math.cos(a) * 85);
      target.set(0, 0, 0);
    } else if (mode === 'group') {
      // Frame everyone: aim at the middle of the pack, back off as they spread out.
      const centre = new THREE.Vector3();
      for (const k of karts) centre.add(k.group.position);
      centre.divideScalar(karts.length);
      let spread = 0;
      for (const k of karts) spread = Math.max(spread, k.group.position.distanceTo(centre));
      const distance = 16 + spread * 1.35;
      desired.set(centre.x, distance * 0.85, centre.z + distance * 0.8);
      target.copy(centre);
    } else {
      // Chase cam: behind and above the kart, looking a little ahead of it.
      const kart = mode === 'chase-only' ? karts[0] : this.karts.get(mode);
      const f = forwardOf(kart.heading);
      const p = kart.group.position;
      desired.set(p.x - f.x * 8.5, 4.2, p.z - f.z * 8.5);
      target.set(p.x + f.x * 5, 1, p.z + f.z * 5);
    }

    // Glide towards the goal instead of snapping: smoother, and hides physics jitter.
    this.camera.position.lerp(desired, smooth(mode === 'overview' ? 1 : 4, dt));
    this.lookAt.lerp(target, smooth(6, dt));
    this.camera.lookAt(this.lookAt);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

// ---------- Models (built from simple shapes) ----------

function standard(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, ...extra });
}

function shadowed(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeKart(color) {
  const group = new THREE.Group();
  const body = new THREE.Group();
  group.add(body);

  const paint = standard(color, { roughness: 0.35, metalness: 0.1 });
  const dark = standard(0x23262d, { roughness: 0.8 });

  // Chassis, nose, side pods and a rear wing. The nose points along +z.
  const chassis = shadowed(new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.38, 2.3), paint));
  chassis.position.set(0, 0.5, 0);
  const nose = shadowed(new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.28, 0.6), paint));
  nose.position.set(0, 0.42, 1.35);
  const bumper = shadowed(new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.18, 0.22), dark));
  bumper.position.set(0, 0.32, 1.62);
  const seat = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.55, 0.25), dark));
  seat.position.set(0, 0.9, -0.55);
  const wing = shadowed(new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 0.4), paint));
  wing.position.set(0, 1.12, -1.15);
  const strut = new THREE.BoxGeometry(0.08, 0.4, 0.2);
  for (const x of [-0.55, 0.55]) {
    const s = shadowed(new THREE.Mesh(strut, dark));
    s.position.set(x, 0.9, -1.12);
    body.add(s);
  }
  body.add(chassis, nose, bumper, seat, wing);

  // Driver: torso, helmet in the player's colour, dark visor facing forward.
  const torso = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.34, 0.6, 12), standard(0xf3f2ee)));
  torso.position.set(0, 1.0, -0.25);
  const helmet = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.33, 20, 14), paint));
  helmet.position.set(0, 1.5, -0.2);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.14, 0.12), standard(0x101216, { roughness: 0.2 }));
  visor.position.set(0, 1.53, 0.08);
  body.add(torso, helmet, visor);

  // Wheels: pivot (steers) > spinner (rolls) > tyre mesh.
  const tyre = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.32, 18);
  tyre.rotateZ(Math.PI / 2); // axle along x
  const wheels = [];
  const frontPivots = [];
  for (const [x, z, front] of [
    [-0.85, 0.85, true],
    [0.85, 0.85, true],
    [-0.85, -0.8, false],
    [0.85, -0.8, false],
  ]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, WHEEL_RADIUS, z);
    const spinner = new THREE.Group();
    const mesh = shadowed(new THREE.Mesh(tyre, dark));
    const hub = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.12), standard(0xb8bcc4));
    spinner.add(mesh, hub);
    pivot.add(spinner);
    group.add(pivot);
    wheels.push(spinner);
    if (front) frontPivots.push(pivot);
  }

  return { group, body, wheels, frontPivots, speed: 0, heading: 0 };
}

function makeNameTag(name, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(8, 8, 112, 48, 14);
  ctx.fill();
  ctx.fillStyle = '#101216';
  ctx.font = '800 34px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(name, 64, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
  sprite.scale.set(1.8, 0.9, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function makeCone() {
  const group = new THREE.Group();
  const cone = shadowed(new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.85, 16), standard(0xff7a1a)));
  cone.position.y = 0.45;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.25, 0.14, 16), standard(0xffffff));
  band.position.y = 0.5;
  const base = shadowed(new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.06, 0.8), standard(0xff7a1a)));
  base.position.y = 0.03;
  group.add(cone, band, base);
  return group;
}

function makeCrate() {
  const crate = shadowed(new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.8, 1.8), standard(0xb07a3e, { roughness: 0.9 })));
  crate.position.y = 0.9;
  const group = new THREE.Group();
  group.add(crate);
  return group;
}

function makeTree() {
  const group = new THREE.Group();
  const trunk = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 2, 10), standard(0x7a5230)));
  trunk.position.y = 1;
  const leaves = shadowed(new THREE.Mesh(new THREE.ConeGeometry(2.2, 4.5, 12), standard(0x2f7d3b, { roughness: 0.9 })));
  leaves.position.y = 4;
  const top = shadowed(new THREE.Mesh(new THREE.ConeGeometry(1.5, 3, 12), standard(0x3a9447, { roughness: 0.9 })));
  top.position.y = 5.8;
  group.add(trunk, leaves, top);
  return group;
}

// ---------- Textures drawn on a canvas (no image files needed) ----------

function canvasTexture(width, height, draw) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  draw(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

function asphaltTexture() {
  return canvasTexture(1024, 1024, (ctx, w, h) => {
    ctx.fillStyle = '#4a4e57';
    ctx.fillRect(0, 0, w, h);
    // Speckle, from a tiny seeded random so it looks the same every load.
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 9000; i++) {
      const shade = 60 + Math.floor(rand() * 40);
      ctx.fillStyle = `rgb(${shade},${shade + 2},${shade + 8})`;
      ctx.fillRect(rand() * w, rand() * h, 2, 2);
    }
    // Painted grid every 10 m (the arena is 120 m across).
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 3;
    const step = w / 12;
    for (let i = 1; i < 12; i++) {
      ctx.beginPath();
      ctx.moveTo(i * step, 0);
      ctx.lineTo(i * step, h);
      ctx.moveTo(0, i * step);
      ctx.lineTo(w, i * step);
      ctx.stroke();
    }
    // A big circle in the middle.
    ctx.strokeStyle = 'rgba(255,196,0,0.55)';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(w / 2, h / 2, step * 1.6, 0, Math.PI * 2);
    ctx.stroke();
  });
}

function checkerTexture(cols, rows) {
  return canvasTexture(cols * 32, rows * 32 * 2, (ctx, w, h) => {
    const size = w / cols;
    for (let y = 0; y < h / size; y++) {
      for (let x = 0; x < cols; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#111' : '#f3f2ee';
        ctx.fillRect(x * size, y * size, size, size);
      }
    }
  });
}

function kerbTexture() {
  const texture = canvasTexture(128, 32, (ctx, w, h) => {
    ctx.fillStyle = '#f3f2ee';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#e23b31';
    ctx.fillRect(0, 0, w / 2, h);
  });
  texture.wrapS = THREE.RepeatWrapping;
  return texture;
}
