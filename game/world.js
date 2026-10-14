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
 *
 * The track (Phase 4) is built from the same samples the physics uses: the road,
 * kerbs and tyre walls are "ribbons", strips of triangles following the centre
 * line at fixed distances to the left and right.
 *
 * "Juice" (Phase 5): effects that make speed and drifting feel good without
 * changing the physics: the kart swings sideways in a drift, sparks fly in the
 * drift's charge colour, boosts get a flame and a wider field of view, landings
 * squash the kart, and hits shake the camera.
 */
import * as THREE from 'three';
import { forwardOf } from './physics.js';

const SKY = 0x8fd0f5;
const WALL_HEIGHT = 1.0;
const WHEEL_RADIUS = 0.34;
const SHADOW_REACH = 70; // m around the camera's focus that get sharp shadows
const BASE_FOV = 60;
const SPARK_COLOURS = [new THREE.Color('#ffe9a8'), new THREE.Color('#3d8bff'), new THREE.Color('#ff8a1f')];

/** 1 - e^(-rate·dt): frame-rate independent smoothing for lerp. */
const smooth = (rate, dt) => 1 - Math.exp(-rate * dt);

export class World {
  constructor(canvas, track) {
    this.track = track;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(SKY);
    this.scene.fog = new THREE.Fog(SKY, 140, 380);

    const { minX, maxX, minZ, maxZ } = track.bounds;
    this.centre = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    this.extent = Math.max(maxX - minX, maxZ - minZ) / 2;

    this.camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.1, 800);
    this.camera.position.set(this.centre.x, 140, this.centre.z + 220);
    this.cameraBase = this.camera.position.clone(); // where the camera is before shake
    this.lookAt = this.centre.clone();
    this.trauma = 0; // camera shake, 0..1, decays over time
    this.speedLines = 0; // 0..1, how strongly to show the boost speed lines
    this.juice = 1; // multiplier for shake and FOV kick (tuning panel)

    this.karts = new Map(); // slot -> { group, wheels, frontPivots, tag }
    this.cameraMode = 'auto'; // 'auto' | 'group' | slot number (chase that kart)

    this.#addLights();
    this.#addGround();
    this.#addTrack();
    this.#addStartLine();
    this.#addCheckpointGates();
    this.#addTrees();
    this.#addFeatures();
    this.sparks = new Sparks(this.scene);
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

    // The sun follows the camera's focus (see updateCamera), so its shadow map
    // only has to cover the area you're looking at: sharp shadows on a big track.
    this.sun = new THREE.DirectionalLight(0xfff2dc, 2.2);
    this.sunOffset = new THREE.Vector3(-40, 80, 30);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const r = SHADOW_REACH;
    Object.assign(this.sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 10, far: 260 });
    this.sun.shadow.bias = -0.0005;
    this.scene.add(this.sun, this.sun.target);
  }

  #addGround() {
    const size = this.extent * 2 + 600;
    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(size, size),
      new THREE.MeshStandardMaterial({ map: grassTexture(size), roughness: 1 }),
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(this.centre.x, -0.02, this.centre.z);
    grass.receiveShadow = true;
    this.scene.add(grass);
  }

  #addTrack() {
    const t = this.track;
    const road = t.roadHalfWidth;
    const kerb = t.kerbWidth;

    // Road surface: asphalt with painted edges and a dashed centre line.
    this.scene.add(
      ribbonMesh(t, () => -road, () => road, { y: 0.02, metresPerTile: 12, map: roadTexture() }),
    );
    // Kerbs: red and white strips just outside each edge.
    const kerbMap = stripeTexture('#e23b31', '#f3f2ee');
    this.scene.add(ribbonMesh(t, () => -road - kerb, () => -road, { y: 0.03, metresPerTile: 4, map: kerbMap }));
    this.scene.add(ribbonMesh(t, () => road, () => road + kerb, { y: 0.03, metresPerTile: 4, map: kerbMap }));
    // Tyre walls: as far out as each sample allows (closer on the inside of tight corners).
    const wallMap = stripeTexture('#2f6fd6', '#f3f2ee', true);
    this.scene.add(wallMesh(t, (p) => -p.barrierLeft, wallMap));
    this.scene.add(wallMesh(t, (p) => p.barrierRight, wallMap));
  }

  #addStartLine() {
    const t = this.track;
    const p = t.pointAt(0);
    const width = (t.roadHalfWidth + t.kerbWidth) * 2;

    // Chequered line across the road.
    const line = new THREE.Mesh(
      new THREE.PlaneGeometry(width, 2.4),
      new THREE.MeshStandardMaterial({ map: checkerTexture(14, 2), roughness: 0.8 }),
    );
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = p.heading;
    line.position.set(p.x, 0.04, p.z);
    line.receiveShadow = true;
    this.scene.add(line);

    // Gantry over it, with the track's name.
    const gantry = new THREE.Group();
    const postGeometry = new THREE.BoxGeometry(0.6, 6, 0.6);
    const metal = standard(0xd9dce2, { metalness: 0.3 });
    for (const side of [-1, 1]) {
      const post = shadowed(new THREE.Mesh(postGeometry, metal));
      post.position.set(side * (width / 2 + 1.5), 3, 0);
      gantry.add(post);
    }
    const banner = shadowed(
      new THREE.Mesh(
        new THREE.BoxGeometry(width + 3.6, 1.6, 0.4),
        [metal, metal, metal, metal, bannerMaterial(t.name), bannerMaterial(t.name)],
      ),
    );
    banner.position.y = 6;
    gantry.add(banner);
    gantry.position.set(p.x, 0, p.z);
    gantry.rotation.y = p.heading;
    this.scene.add(gantry);

    // Painted grid boxes.
    const boxMaterial = new THREE.MeshBasicMaterial({ color: 0xf3f2ee, transparent: true, opacity: 0.85 });
    for (const slot of [1, 2, 3, 4]) {
      const g = t.gridPosition(slot);
      const box = new THREE.Group();
      for (const [w, d, x, z] of [
        [2.6, 0.18, 0, 1.6],
        [0.18, 1.4, -1.2, 0.9],
        [0.18, 1.4, 1.2, 0.9],
      ]) {
        const bar = new THREE.Mesh(new THREE.PlaneGeometry(w, d), boxMaterial);
        bar.rotation.x = -Math.PI / 2;
        bar.position.set(x, 0.035, z);
        box.add(bar);
      }
      box.position.set(g.x, 0, g.z);
      box.rotation.y = g.heading;
      this.scene.add(box);
    }
  }

  /** Invisible unless toggled (G): where the race's checkpoints are. */
  #addCheckpointGates(count = 8) {
    this.gates = new THREE.Group();
    const t = this.track;
    const material = new THREE.MeshBasicMaterial({
      color: 0xffc400,
      transparent: true,
      opacity: 0.25,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    for (let k = 0; k < count; k++) {
      const p = t.pointAt((k / count) * t.length);
      const gate = new THREE.Mesh(new THREE.PlaneGeometry((t.roadHalfWidth + t.kerbWidth) * 2, 4), material);
      gate.position.set(p.x, 2, p.z);
      gate.rotation.y = p.heading;
      this.gates.add(gate);
    }
    this.gates.visible = false;
    this.scene.add(this.gates);
  }

  toggleGates() {
    this.gates.visible = !this.gates.visible;
    return this.gates.visible;
  }

  /**
   * Trees everywhere except near the track. One InstancedMesh per tree part
   * draws all ~150 trees in three draw calls instead of ~450.
   */
  #addTrees() {
    const t = this.track;
    const { minX, maxX, minZ, maxZ } = t.bounds;
    let seed = 11;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const spots = [];
    for (let tries = 0; spots.length < 160 && tries < 4000; tries++) {
      const x = minX - 60 + rand() * (maxX - minX + 120);
      const z = minZ - 60 + rand() * (maxZ - minZ + 120);
      const where = t.locate(x, z);
      const wall = where.lateral > 0 ? where.barrierRight : where.barrierLeft;
      if (Math.abs(where.lateral) < wall + 5) continue; // keep the run-off clear
      spots.push({ x, z, scale: 0.8 + rand() * 0.6, turn: rand() * Math.PI });
    }

    const parts = [
      { geometry: new THREE.CylinderGeometry(0.35, 0.45, 2, 8), color: 0x7a5230, y: 1 },
      { geometry: new THREE.ConeGeometry(2.2, 4.5, 10), color: 0x2f7d3b, y: 4 },
      { geometry: new THREE.ConeGeometry(1.5, 3, 10), color: 0x3a9447, y: 5.8 },
    ];
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (const part of parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, standard(part.color, { roughness: 0.9 }), spots.length);
      spots.forEach((spot, i) => {
        position.set(spot.x, part.y * spot.scale, spot.z);
        rotation.setFromAxisAngle(up, spot.turn);
        scale.setScalar(spot.scale);
        mesh.setMatrixAt(i, matrix.compose(position, rotation, scale));
      });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
    }
  }

  /** Boost pads (scrolling chevrons) and the ramp, built along the track like the road. */
  #addFeatures() {
    this.padTextures = [];
    for (const f of this.track.features) {
      if (f.type === 'boost') {
        const map = chevronTexture();
        map.wrapT = THREE.RepeatWrapping;
        map.repeat.set(1, 2);
        this.padTextures.push(map);
        const strip = featureStrip(this.track, f, { y: 0.045, steps: 12 });
        const mesh = new THREE.Mesh(strip, new THREE.MeshBasicMaterial({ map, transparent: true }));
        this.scene.add(mesh);
      } else if (f.type === 'ramp') {
        const { top, sides } = rampGeometry(this.track, f);
        const stripes = stripeTexture('#ffc400', '#23262d');
        stripes.wrapT = THREE.RepeatWrapping;
        stripes.repeat.set(1, 4);
        const topMesh = new THREE.Mesh(top, new THREE.MeshStandardMaterial({ map: stripes, roughness: 0.7 }));
        const sideMesh = new THREE.Mesh(sides, standard(0x3a3e47, { side: THREE.DoubleSide }));
        for (const m of [topMesh, sideMesh]) {
          m.castShadow = true;
          m.receiveShadow = true;
          this.scene.add(m);
        }
      }
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

  /** A short squash when a kart lands from a jump. */
  squash(slot, amount = 1) {
    const kart = this.karts.get(slot);
    if (kart) kart.squash = Math.max(kart.squash, amount);
  }

  /** Shake the camera. `amount` 0..1 adds up and fades out. */
  shake(amount) {
    this.trauma = Math.min(1, this.trauma + amount * this.juice);
  }

  removeKart(slot) {
    const kart = this.karts.get(slot);
    if (!kart) return;
    this.scene.remove(kart.group);
    this.karts.delete(slot);
  }

  /**
   * Move a kart's model to the pose physics computed, and play its effects.
   * `state` is the physics kart (speed, drift, boost, airborne).
   */
  updateKart(slot, { x, y, z, heading }, state, steer, dt) {
    const kart = this.karts.get(slot);
    if (!kart) return;
    const { speed, drift, boost, airborne } = state;
    kart.group.position.set(x, y ?? 0, z);
    kart.group.rotation.y = heading;
    kart.speed = speed;
    kart.heading = heading;
    kart.boost = boost;

    // Wheels roll with speed; front wheels turn with steering (right = negative yaw).
    for (const wheel of kart.wheels) wheel.rotation.x += (speed * dt) / WHEEL_RADIUS;
    for (const pivot of kart.frontPivots) pivot.rotation.y = -steer * 0.45;

    // Drift: the whole kart swings its nose into the turn while it travels along
    // the physics heading. That sideways angle is what reads as "sliding".
    const driftYaw = -drift.dir * 0.4;
    kart.drifter.rotation.y = THREE.MathUtils.lerp(kart.drifter.rotation.y, driftYaw, smooth(8, dt));

    // Lean the body a little into turns at speed: cheap, but it sells the motion.
    const lean = (drift.dir || steer) * Math.min(Math.abs(speed) / 24, 1) * (drift.dir ? 0.12 : 0.08);
    kart.body.rotation.z = THREE.MathUtils.lerp(kart.body.rotation.z, lean, smooth(10, dt));

    // Landing squash, springing back.
    kart.squash = Math.max(0, kart.squash - dt * 4);
    const sq = Math.sin(kart.squash * Math.PI) * 0.22 * this.juice;
    kart.drifter.scale.set(1 + sq * 0.5, 1 - sq, 1 + sq * 0.5);

    // Boost flame, flickering.
    kart.flame.visible = boost > 0;
    if (boost > 0) kart.flame.scale.set(1, 1, 0.7 + Math.random() * 0.6 + Math.min(boost, 1) * 0.5);

    // Sparks from the rear wheels while drifting, in the charge colour.
    if (drift.dir !== 0 && !airborne) {
      kart.sparkDebt += dt * (drift.level === 0 ? 30 : 90);
      kart.group.updateMatrixWorld();
      const back = new THREE.Vector3(-Math.sin(heading), 0, -Math.cos(heading));
      while (kart.sparkDebt >= 1) {
        kart.sparkDebt -= 1;
        const side = Math.random() < 0.5 ? -0.85 : 0.85;
        const at = kart.drifter.localToWorld(new THREE.Vector3(side, 0.15, -0.85));
        const v = back.clone().multiplyScalar(2 + Math.random() * 3);
        v.x += (Math.random() - 0.5) * 3;
        v.z += (Math.random() - 0.5) * 3;
        v.y = 1.5 + Math.random() * 2.5;
        this.sparks.emit(at, v, SPARK_COLOURS[drift.level]);
      }
    } else {
      kart.sparkDebt = 0;
    }
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
      // Nobody here yet: slowly circle the whole track.
      const a = time * 0.04;
      const r = this.extent * 1.35;
      desired.set(this.centre.x + Math.sin(a) * r, this.extent * 0.9, this.centre.z + Math.cos(a) * r);
      target.copy(this.centre);
    } else if (mode === 'group') {
      // Frame everyone: aim at the middle of the pack, back off as they spread out.
      const centre = new THREE.Vector3();
      for (const k of karts) centre.add(k.group.position);
      centre.divideScalar(karts.length);
      let spread = 0;
      for (const k of karts) spread = Math.max(spread, k.group.position.distanceTo(centre));
      const distance = Math.min(16 + spread * 1.35, this.extent * 2.2);
      desired.set(centre.x, distance * 0.85, centre.z + distance * 0.8);
      target.copy(centre);
    } else {
      // Chase cam: behind and above the kart, looking a little ahead of it.
      const kart = mode === 'chase-only' ? karts[0] : this.karts.get(mode);
      const f = forwardOf(kart.heading);
      const p = kart.group.position;
      desired.set(p.x - f.x * 8.5, p.y + 4.2, p.z - f.z * 8.5); // rises with the kart over jumps
      target.set(p.x + f.x * 5, p.y + 1, p.z + f.z * 5);
    }

    // Glide towards the goal instead of snapping: smoother, and hides physics jitter.
    this.cameraBase.lerp(desired, smooth(mode === 'overview' ? 1 : 4, dt));
    this.lookAt.lerp(target, smooth(6, dt));

    // Shake: a random nudge that grows with trauma², so small hits barely show.
    this.trauma = Math.max(0, this.trauma - dt * 1.8);
    const shake = this.trauma * this.trauma * 0.8;
    this.camera.position.set(
      this.cameraBase.x + (Math.random() - 0.5) * shake,
      this.cameraBase.y + (Math.random() - 0.5) * shake,
      this.cameraBase.z + (Math.random() - 0.5) * shake,
    );
    this.camera.lookAt(this.lookAt);

    // Field of view widens with speed, and more while boosting: speed you can feel.
    const focus = mode === 'chase-only' ? karts[0] : typeof mode === 'number' ? this.karts.get(mode) : null;
    const speed = focus ? Math.abs(focus.speed) : 0;
    const boosting = focus ? focus.boost > 0 : karts.some((k) => k.boost > 0);
    const fov = BASE_FOV + (Math.min(speed / 24, 1.3) * 5 + (boosting ? 9 : 0)) * this.juice;
    this.speedLines = THREE.MathUtils.lerp(this.speedLines, boosting ? Math.min(1, this.juice) : 0, smooth(6, dt));
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, fov, smooth(5, dt));
      this.camera.updateProjectionMatrix();
    }

    // Moving parts of the scenery.
    this.sparks.update(dt);
    for (const map of this.padTextures) map.offset.y = (map.offset.y - dt * 1.5) % 1;

    // Keep the sun's shadow box centred on what we're looking at.
    this.sun.target.position.copy(this.lookAt);
    this.sun.position.copy(this.lookAt).add(this.sunOffset);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

// ---------- Track geometry ----------

/**
 * A flat strip along the track between two sideways offsets (in metres, + = right).
 * Texture u runs across the strip, v along it, repeating every `metresPerTile`.
 */
function ribbonMesh(track, fromOffset, toOffset, { y, metresPerTile, map }) {
  const { samples, length } = track;
  const n = samples.length;
  const tiles = Math.max(1, Math.round(length / metresPerTile)); // whole tiles, so the seam matches
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i <= n; i++) {
    const p = samples[i % n];
    const v = (i / n) * tiles;
    for (const [offset, u] of [
      [fromOffset(p), 0],
      [toOffset(p), 1],
    ]) {
      positions.push(p.x + p.rx * offset, y, p.z + p.rz * offset);
      uvs.push(u, v);
    }
    if (i < n) {
      const a = i * 2; // left edge of this row; a+1 = right edge; a+2, a+3 = next row
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); // wound so the face points up
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  map.wrapT = THREE.RepeatWrapping;
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map, roughness: 0.9 }));
  mesh.receiveShadow = true;
  return mesh;
}

/** An upright wall along the track at a sideways offset per sample. */
function wallMesh(track, offsetAt, map) {
  const { samples, length } = track;
  const n = samples.length;
  const tiles = Math.max(1, Math.round(length / 3));
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i <= n; i++) {
    const p = samples[i % n];
    const offset = offsetAt(p);
    const x = p.x + p.rx * offset;
    const z = p.z + p.rz * offset;
    positions.push(x, 0, z, x, WALL_HEIGHT, z);
    const u = (i / n) * tiles;
    uvs.push(u, 0, u, 1);
    if (i < n) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  map.wrapS = THREE.RepeatWrapping;
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ map, roughness: 0.7, side: THREE.DoubleSide }),
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A flat strip on the road for a feature (boost pad), following the track's curve. */
function featureStrip(track, f, { y, steps }) {
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = track.pointAt(f.s + f.length * t);
    for (const [side, u] of [
      [-1, 0],
      [1, 1],
    ]) {
      const off = f.lateral + side * f.halfWidth;
      positions.push(p.x + p.rx * off, y, p.z + p.rz * off);
      uvs.push(u, t);
    }
    if (i < steps) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** The ramp: a sloped top following the track, plus side and end walls. */
function rampGeometry(track, f) {
  const steps = 16;
  const top = [];
  const uvs = [];
  const topIndex = [];
  const side = [];
  const sideIndex = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = track.pointAt(f.s + f.length * t);
    const h = f.height * t;
    const left = [p.x - p.rx * f.halfWidth, p.z - p.rz * f.halfWidth];
    const right = [p.x + p.rx * f.halfWidth, p.z + p.rz * f.halfWidth];
    top.push(left[0], h, left[1], right[0], h, right[1]);
    uvs.push(0, t, 1, t);
    // Side walls: bottom and top of each side.
    side.push(left[0], 0, left[1], left[0], h, left[1], right[0], 0, right[1], right[0], h, right[1]);
    if (i < steps) {
      const a = i * 2;
      topIndex.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      const b = i * 4;
      sideIndex.push(b, b + 4, b + 1, b + 1, b + 4, b + 5, b + 2, b + 3, b + 6, b + 3, b + 7, b + 6);
    }
  }
  // End wall at the top of the ramp (the drop you fly off).
  const e = steps * 4;
  sideIndex.push(e, e + 2, e + 1, e + 1, e + 2, e + 3);

  const topGeometry = new THREE.BufferGeometry();
  topGeometry.setAttribute('position', new THREE.Float32BufferAttribute(top, 3));
  topGeometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  topGeometry.setIndex(topIndex);
  topGeometry.computeVertexNormals();
  const sideGeometry = new THREE.BufferGeometry();
  sideGeometry.setAttribute('position', new THREE.Float32BufferAttribute(side, 3));
  sideGeometry.setIndex(sideIndex);
  sideGeometry.computeVertexNormals();
  return { top: topGeometry, sides: sideGeometry };
}

/**
 * A pool of spark particles drawn as one THREE.Points: cheap enough for hundreds.
 * Each spark flies, falls and fades out after a third of a second.
 */
class Sparks {
  constructor(scene, count = 400) {
    this.count = count;
    this.next = 0;
    this.positions = new Float32Array(count * 3).fill(-1000);
    this.colors = new Float32Array(count * 3);
    this.velocities = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    this.geometry = geometry;
    this.points = new THREE.Points(
      geometry,
      new THREE.PointsMaterial({
        size: 0.32,
        map: sparkTexture(), // soft round dot instead of a hard square
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  emit(at, velocity, color) {
    const i = this.next++ % this.count;
    this.positions.set([at.x, at.y, at.z], i * 3);
    this.velocities.set([velocity.x, velocity.y, velocity.z], i * 3);
    this.colors.set([color.r, color.g, color.b], i * 3);
    this.life[i] = 0.3 + Math.random() * 0.15;
  }

  update(dt) {
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      const k = i * 3;
      if (this.life[i] <= 0) {
        this.positions[k + 1] = -1000; // hide
        continue;
      }
      this.velocities[k + 1] -= 12 * dt;
      this.positions[k] += this.velocities[k] * dt;
      this.positions[k + 1] = Math.max(0.05, this.positions[k + 1] + this.velocities[k + 1] * dt);
      this.positions[k + 2] += this.velocities[k + 2] * dt;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.color.needsUpdate = true;
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
  // group (position + heading) > drifter (drift swing, squash) > body + wheels
  const group = new THREE.Group();
  const drifter = new THREE.Group();
  const body = new THREE.Group();
  group.add(drifter);
  drifter.add(body);

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
    drifter.add(pivot);
    wheels.push(spinner);
    if (front) frontPivots.push(pivot);
  }

  // Boost flame out the back: a cone pointing backwards, glowing (additive blending).
  const flameGeometry = new THREE.ConeGeometry(0.28, 1.3, 12);
  flameGeometry.rotateX(-Math.PI / 2); // tip towards -z
  flameGeometry.translate(0, 0, -0.65);
  const flame = new THREE.Mesh(
    flameGeometry,
    new THREE.MeshBasicMaterial({ color: 0xffa31a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  flame.position.set(0, 0.55, -1.3);
  flame.visible = false;
  drifter.add(flame);

  return { group, drifter, body, wheels, frontPivots, flame, speed: 0, heading: 0, boost: 0, squash: 0, sparkDebt: 0 };
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


/** One road tile: asphalt speckle, white edge lines, a dashed centre line. */
function roadTexture() {
  return canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#4a4e57';
    ctx.fillRect(0, 0, w, h);
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 2500; i++) {
      const shade = 60 + Math.floor(rand() * 40);
      ctx.fillStyle = `rgb(${shade},${shade + 2},${shade + 8})`;
      ctx.fillRect(rand() * w, rand() * h, 2, 2);
    }
    ctx.fillStyle = '#f3f2ee';
    ctx.fillRect(4, 0, 6, h); // edge lines
    ctx.fillRect(w - 10, 0, 6, h);
    ctx.fillStyle = 'rgba(243,242,238,0.75)';
    ctx.fillRect(w / 2 - 2, 0, 4, h / 2); // centre dash
  });
}

/**
 * Two-colour stripes. Ribbons run along the track in v (kerbs); walls run
 * along it in u, so their stripes go the other way.
 */
function stripeTexture(a, b, alongU = false) {
  return canvasTexture(64, 64, (ctx, w, h) => {
    ctx.fillStyle = a;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = b;
    if (alongU) ctx.fillRect(w / 2, 0, w / 2, h);
    else ctx.fillRect(0, h / 2, w, h / 2);
  });
}

/** A soft white dot: brightest in the middle, fading to nothing at the edge. */
function sparkTexture() {
  return canvasTexture(32, 32, (ctx, w, h) => {
    const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.8)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

/** Yellow chevrons pointing along the track (v), for boost pads. */
function chevronTexture() {
  return canvasTexture(128, 128, (ctx, w, h) => {
    ctx.fillStyle = 'rgba(255, 90, 20, 0.85)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#ffd400';
    ctx.lineWidth = 16;
    ctx.lineJoin = 'miter';
    for (const y0 of [24, 88]) {
      ctx.beginPath();
      ctx.moveTo(16, y0 + 28);
      ctx.lineTo(w / 2, y0);
      ctx.lineTo(w - 16, y0 + 28);
      ctx.stroke();
    }
  });
}

function grassTexture(size) {
  const texture = canvasTexture(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#67a84e';
    ctx.fillRect(0, 0, w, h);
    let seed = 3;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 1800; i++) {
      ctx.fillStyle = rand() > 0.5 ? '#5f9d47' : '#72b358';
      ctx.fillRect(rand() * w, rand() * h, 3, 3);
    }
  });
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(size / 20, size / 20);
  return texture;
}

function bannerMaterial(text) {
  const map = canvasTexture(1024, 128, (ctx, w, h) => {
    ctx.fillStyle = '#101216';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffc400';
    ctx.font = 'italic 900 78px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text.toUpperCase(), w / 2, h / 2 + 4);
  });
  return new THREE.MeshStandardMaterial({ map, roughness: 0.6 });
}
