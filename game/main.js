/**
 * Game screen.
 *
 *   relay (Phase 2) ─► InputHub ◄─ keyboard
 *                         │
 *          fixed 120 Hz physics (physics.js)
 *                         │
 *          Three.js world draws it every frame (world.js), plus the HUD
 *
 * Every player in the room gets a kart. Arrows drive P1 and W A S D drive P2,
 * so you can test without phones; holding keys overrides that player's phone.
 */
import QRCode from 'qrcode';
import { ERRORS, PLAYERS, playerInfo } from '../shared/protocol.js';
import { createConnection } from '../shared/net.js';
import { relayUrl } from '../shared/relay-url.js';
import { createKart, interpolate, stepWorld } from './physics.js';
import { createFixedStep } from './loop.js';
import { InputHub } from './input.js';
import { ARENA, OBSTACLES, startPosition } from './course.js';
import { World } from './world.js';

const ROOM_KEY = 'kart.game.room'; // remembers our room across reloads
const STALE_INPUT_MS = 500;

const $ = (id) => document.getElementById(id);

// ---------- State ----------

/** slot -> player info from the relay. `present` = someone holds this slot. */
const players = new Map(
  PLAYERS.map((p) => [
    p.slot,
    { ...p, present: false, connected: false, lastInputAt: 0, inputTimes: [], phoneRtt: null, steer: 0 },
  ]),
);

const input = new InputHub({ staleMs: STALE_INPUT_MS });
const physics = { karts: new Map(), arena: ARENA, obstacles: OBSTACLES };
const world = new World($('scene'));

let room = loadRoom();
let fatal = null;

function loadRoom() {
  try {
    return JSON.parse(sessionStorage.getItem(ROOM_KEY)) || null;
  } catch {
    return null;
  }
}

function saveRoom(value) {
  try {
    sessionStorage.setItem(ROOM_KEY, JSON.stringify(value));
  } catch {
    // storage blocked: a reload will just open a new room
  }
}

// ---------- Karts come and go with players ----------

/** A slot gets a kart while a phone holds it, or once the keyboard has driven it. */
function syncKarts() {
  for (const { slot } of PLAYERS) {
    const wanted = players.get(slot).present || input.keyboardUsed.has(slot);
    if (wanted && !physics.karts.has(slot)) {
      physics.karts.set(slot, createKart(startPosition(slot)));
      world.addKart(slot, playerInfo(slot));
    } else if (!wanted && physics.karts.has(slot)) {
      physics.karts.delete(slot);
      world.removeKart(slot);
    }
  }
}

function resetKarts() {
  for (const slot of physics.karts.keys()) physics.karts.set(slot, createKart(startPosition(slot)));
}

// ---------- Connection to the relay ----------

const conn = createConnection({
  url: relayUrl(),
  // Every (re)connect: ask for our previous room back, if we had one.
  hello: () => ({ type: 'host', code: room?.code, token: room?.token }),
  onMessage: handleMessage,
});

function handleMessage(msg) {
  switch (msg.type) {
    case 'room':
      if (msg.code !== room?.code) showJoinInfo(msg.code);
      room = { code: msg.code, token: msg.token };
      saveRoom(room);
      break;

    case 'player': {
      const p = players.get(msg.slot);
      if (!p) return;
      p.present = true;
      p.connected = msg.connected;
      if (!msg.connected) p.inputTimes = [];
      syncKarts();
      break;
    }

    case 'player-removed': {
      const p = players.get(msg.slot);
      if (p) Object.assign(p, { present: false, connected: false, phoneRtt: null, inputTimes: [] });
      input.forgetPhone(msg.slot);
      syncKarts();
      break;
    }

    case 'input': {
      const p = players.get(msg.slot);
      if (!p) return;
      const now = performance.now();
      p.lastInputAt = now;
      p.inputTimes.push(now);
      p.steer = msg.steer;
      if (typeof msg.rtt === 'number') p.phoneRtt = msg.rtt;
      input.phoneInput(msg.slot, msg, now);
      break;
    }

    case 'error':
      if (msg.reason === ERRORS.REPLACED) {
        fatal = 'This room is now open in another tab. Close this one, or reload it to open a new room.';
        sessionStorage.removeItem(ROOM_KEY);
        conn.stop();
      }
      break;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') conn.reconnectNow();
});
window.addEventListener('online', () => conn.reconnectNow());

// ---------- Join panel: QR code ----------

/**
 * Phones can't reach "localhost": that's themselves. When this screen is
 * opened on localhost, ask the dev server for this computer's Wi-Fi address.
 */
async function joinOrigin() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (!local) return location.origin;
  try {
    const { origins } = await (await fetch('/__kart/lan')).json();
    if (origins?.length) return origins[0];
  } catch {
    // not running under the dev server
  }
  $('join-warning').textContent = 'No Wi-Fi address found, so phones can’t reach this computer.';
  $('join-warning').hidden = false;
  return location.origin;
}

async function showJoinInfo(code) {
  $('room-code').textContent = code;
  const url = `${await joinOrigin()}/controller/?room=${code}`;
  $('join-url').textContent = url;
  $('qr').innerHTML = await QRCode.toString(url, {
    type: 'svg',
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#101216', light: '#ffffff' },
  });
}

if (room) showJoinInfo(room.code); // show the remembered code straight away while we reconnect

// ---------- Keyboard ----------

const steeringKeys = input.keyCodes;

window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (steeringKeys.has(e.code)) {
    e.preventDefault(); // arrows would scroll the page
    input.keyDown(e.code);
    syncKarts();
    return;
  }
  if (e.repeat) return;
  if (e.code === 'KeyC') $('camera-chip').textContent = world.cycleCamera();
  if (e.code === 'KeyR') resetKarts();
  if (e.code === 'KeyQ') $('join').hidden = !$('join').hidden;
  if (e.code === 'KeyI') $('debug').hidden = !$('debug').hidden;
});
window.addEventListener('keyup', (e) => input.keyUp(e.code));
window.addEventListener('blur', () => input.releaseAllKeys()); // we'd never see those key-ups

// ---------- Physics: fixed 120 Hz steps ----------

let frameNow = performance.now();
const lastInput = new Map(); // slot -> input used in the latest step (for the HUD and wheels)

const loop = createFixedStep({
  stepHz: 120,
  step(dt) {
    input.tick(dt);
    stepWorld(
      physics,
      (slot) => {
        const i = input.get(slot, frameNow);
        lastInput.set(slot, i);
        return i;
      },
      dt,
    );
  },
});

// ---------- HUD ----------

const hudChips = new Map();
const template = $('hud-chip');
for (const p of PLAYERS) {
  const chip = template.content.firstElementChild.cloneNode(true);
  chip.style.setProperty('--player', p.color);
  chip.querySelector('.badge').textContent = p.name;
  chip.hidden = true;
  $('hud').append(chip);
  hudChips.set(p.slot, {
    chip,
    kmh: chip.querySelector('.kmh'),
    source: chip.querySelector('.source'),
    fill: chip.querySelector('.steer-fill'),
    gas: chip.querySelector('.gas'),
    brake: chip.querySelector('.brake'),
  });
}

const ms = (n) => (n === null || n === undefined ? '–' : `${Math.round(n)} ms`);

function renderHud() {
  for (const { slot } of PLAYERS) {
    const ui = hudChips.get(slot);
    const kart = physics.karts.get(slot);
    ui.chip.hidden = !kart;
    if (!kart) continue;

    const p = players.get(slot);
    const i = lastInput.get(slot) ?? { steer: 0, gas: false, brake: false, source: 'none' };
    ui.kmh.textContent = Math.round(Math.abs(kart.speed) * 3.6);
    ui.source.textContent =
      i.source === 'keyboard'
        ? 'keyboard'
        : i.source === 'phone'
          ? `phone · ${ms(p.phoneRtt)}`
          : p.present && !p.connected
            ? 'phone reconnecting…'
            : p.present
              ? 'phone idle'
              : 'keyboard idle';
    ui.chip.classList.toggle('offline', p.present && !p.connected && i.source !== 'keyboard');
    const width = Math.abs(i.steer) * 50;
    ui.fill.style.left = `${i.steer >= 0 ? 50 : 50 - width}%`;
    ui.fill.style.width = `${width}%`;
    ui.gas.classList.toggle('on', i.gas);
    ui.brake.classList.toggle('on', i.brake);
  }
}

function renderServerChip() {
  const chip = $('server-chip');
  const status = conn.status;
  chip.textContent = {
    connecting: 'connecting…',
    connected: `relay ${ms(conn.rtt)}`,
    reconnecting: 'reconnecting…',
    stopped: 'disconnected',
  }[status];
  chip.className = `chip ${status === 'connected' ? 'good' : 'warn'}`;
}

let fps = 0;
let stepsThisSecond = 0;
let stepRate = 0;
let fpsWindowStart = performance.now();
let framesThisSecond = 0;

function renderDebug(now) {
  if ($('debug').hidden) return;
  const rows = [];
  for (const p of players.values()) {
    if (!p.present) continue;
    while (p.inputTimes.length && now - p.inputTimes[0] > 1000) p.inputTimes.shift();
    const age = p.lastInputAt ? now - p.lastInputAt : null;
    const latency = p.phoneRtt !== null && conn.rtt !== null ? p.phoneRtt / 2 + conn.rtt / 2 : null;
    rows.push(
      `<tr><td style="color:${p.color}">${p.name}</td>` +
        `<td>${p.connected ? 'connected' : 'reconnecting'}</td>` +
        `<td>${p.inputTimes.length}</td>` +
        `<td>${ms(p.phoneRtt)}</td>` +
        `<td class="${latency > 50 ? 'bad' : ''}">${latency === null ? '–' : `≈ ${Math.round(latency)} ms`}</td>` +
        `<td class="${age === null || age > STALE_INPUT_MS ? 'bad' : ''}">${age === null ? '–' : age > 5000 ? `${Math.round(age / 1000)} s` : ms(age)}</td></tr>`,
    );
  }
  $('debug-rows').innerHTML = rows.join('') || '<tr><td colspan="6">No phones yet</td></tr>';
  $('debug-footer').textContent = `${fps} fps · physics ${stepRate} steps/s · relay ${ms(conn.rtt)} · room ${room?.code ?? '····'}`;
}

function renderBanner() {
  const banner = $('banner');
  const message = fatal ?? (conn.status === 'reconnecting' ? 'Lost the relay server. Reconnecting…' : null);
  banner.hidden = !message;
  if (message) banner.textContent = message;
}

// ---------- Frame ----------

let lastFrame = performance.now();

function frame(now) {
  const frameMs = now - lastFrame;
  lastFrame = now;
  frameNow = now;

  const { steps, alpha } = loop.advance(frameMs);

  const dt = Math.min(frameMs, 100) / 1000;
  for (const [slot, kart] of physics.karts) {
    world.updateKart(slot, interpolate(kart, alpha), kart.speed, lastInput.get(slot)?.steer ?? 0, dt);
  }
  world.updateCamera(dt, now / 1000);
  world.render();

  renderHud();
  renderServerChip();
  renderBanner();
  renderDebug(now);

  framesThisSecond++;
  stepsThisSecond += steps;
  if (now - fpsWindowStart >= 1000) {
    fps = framesThisSecond;
    stepRate = stepsThisSecond;
    framesThisSecond = 0;
    stepsThisSecond = 0;
    fpsWindowStart = now;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
