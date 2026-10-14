/**
 * Game screen.
 *
 *   relay (Phase 2) ─► InputHub ◄─ keyboard
 *                         │
 *          fixed 120 Hz physics on the track (physics.js, track.js)
 *                         │
 *          race rules: countdown, laps, standings (race.js)
 *                         │
 *          Three.js world draws it every frame (world.js), plus HUD and minimap
 *
 * Every player in the room gets a kart. Arrows drive P1 and W A S D drive P2,
 * so you can test without phones; holding keys overrides that player's phone.
 * Space starts a race.
 *
 * Phase 5: physics events (drifts, boosts, jumps, hits) go to feedback.js,
 * which shakes the camera and buzzes each player's phone. T opens tuning.
 */
import QRCode from 'qrcode';
import { ERRORS, PLAYERS, playerInfo } from '../shared/protocol.js';
import { createConnection } from '../shared/net.js';
import { relayUrl } from '../shared/relay-url.js';
import { createKart, interpolate, stepWorld } from './physics.js';
import { createFixedStep } from './loop.js';
import { InputHub } from './input.js';
import { buildTrack } from './track.js';
import { Race, formatTime } from './race.js';
import { World } from './world.js';
import { Minimap } from './minimap.js';
import { Feedback } from './feedback.js';
import { createTuningPanel, loadParams } from './tuning.js';

const ROOM_KEY = 'kart.game.room'; // remembers our room across reloads
const STALE_INPUT_MS = 500;
const NO_INPUT = Object.freeze({ steer: 0, gas: false, brake: false, source: 'none' });

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
const track = buildTrack();
// ?laps=1 on the game screen's address for quick test races.
const lapsParam = Number(new URLSearchParams(location.search).get('laps'));
const race = new Race(track, Number.isInteger(lapsParam) && lapsParam >= 1 && lapsParam <= 20 ? { laps: lapsParam } : {});
const physics = { karts: new Map(), track, obstacles: [] };
const world = new World($('scene'), track);
const minimap = new Minimap($('minimap'), track);
const params = loadParams(); // kart physics numbers; the tuning panel (T) edits these live
const tuning = createTuningPanel(params, { world, onMessage: (text) => toast(text) });

// Physics events -> camera shake and phone vibration (only to phones that are connected).
const feedback = new Feedback({
  send(slot, data) {
    const p = players.get(slot);
    if (p?.present && p.connected) conn.send({ type: 'to-player', slot, data });
  },
  effects: { shake: (amount) => world.shake(amount), squash: (slot) => world.squash(slot) },
});
const RECORD_KEY = `kart.record.${track.name}`;
let record = loadRecord(); // fastest lap ever on this track, on this screen

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

function loadRecord() {
  try {
    return JSON.parse(localStorage.getItem(RECORD_KEY)) || null;
  } catch {
    return null;
  }
}

function saveRecord(value) {
  try {
    localStorage.setItem(RECORD_KEY, JSON.stringify(value));
  } catch {
    // fine: the record just won't survive a reload
  }
}

// ---------- Karts come and go with players ----------

/** A slot gets a kart while a phone holds it, or once the keyboard has driven it. */
function syncKarts() {
  for (const { slot } of PLAYERS) {
    const wanted = players.get(slot).present || input.keyboardUsed.has(slot);
    if (wanted && !physics.karts.has(slot)) {
      physics.karts.set(slot, createKart(track.gridPosition(slot)));
      world.addKart(slot, playerInfo(slot));
    } else if (!wanted && physics.karts.has(slot)) {
      physics.karts.delete(slot);
      world.removeKart(slot);
    }
  }
}

/** Everyone back to their grid box, standing still. */
function resetKarts() {
  for (const slot of physics.karts.keys()) physics.karts.set(slot, createKart(track.gridPosition(slot)));
}

function startRace() {
  if (physics.karts.size === 0) {
    toast('Join with a phone (or press ↑) first, then start the race.');
    return;
  }
  resetKarts();
  $('results').hidden = true;
  $('alerts').replaceChildren();
  race.start(physics.karts);
}

function backToPractice() {
  race.stop();
  resetKarts();
  $('results').hidden = true;
  $('alerts').replaceChildren();
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
      if (msg.connected) feedback.forget(msg.slot); // (re)joined: resend its drift state
      syncKarts();
      break;
    }

    case 'player-removed': {
      const p = players.get(msg.slot);
      if (p) Object.assign(p, { present: false, connected: false, phoneRtt: null, inputTimes: [] });
      input.forgetPhone(msg.slot);
      feedback.forget(msg.slot);
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
  if ((e.code === 'Space' || e.code === 'Enter') && (race.phase === 'practice' || race.phase === 'finished')) {
    e.preventDefault();
    startRace();
  }
  if (e.code === 'KeyC') $('camera-chip').textContent = world.cycleCamera();
  if (e.code === 'KeyR') backToPractice();
  if (e.code === 'KeyG') toast(world.toggleGates() ? 'Showing checkpoint gates' : 'Checkpoint gates hidden');
  if (e.code === 'KeyT') tuning.toggle();
  if (e.code === 'KeyQ') $('join').hidden = !$('join').hidden;
  if (e.code === 'KeyI') $('debug').hidden = !$('debug').hidden;
});
window.addEventListener('keyup', (e) => input.keyUp(e.code));
window.addEventListener('blur', () => input.releaseAllKeys()); // we'd never see those key-ups
$('start-race').addEventListener('click', (e) => {
  e.currentTarget.blur(); // so Space doesn't "click" it again later
  startRace();
});

// ---------- Physics: fixed 120 Hz steps ----------

let frameNow = performance.now();
const lastInput = new Map(); // slot -> input used in the latest step (for the HUD and wheels)
const raceEvents = []; // filled by physics steps, shown on the next frame
const physicsEvents = []; // drifts, boosts, jumps, hits: for effects and phone vibration

const loop = createFixedStep({
  stepHz: 120,
  step(dt) {
    input.tick(dt);
    const events = stepWorld(
      physics,
      (slot) => {
        // During the countdown everyone waits on the line.
        const i = race.frozen ? NO_INPUT : input.get(slot, frameNow);
        lastInput.set(slot, i);
        return i;
      },
      dt,
      params,
    );
    physicsEvents.push(...events);
    raceEvents.push(...race.update(dt, physics.karts));
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
    place: chip.querySelector('.place'),
    charge: chip.querySelector('.charge'),
    lap: chip.querySelector('.lap'),
    laptime: chip.querySelector('.laptime'),
    best: chip.querySelector('.best'),
  });
}

const ordinal = (n) => `${n}<sup>${{ 1: 'st', 2: 'nd', 3: 'rd' }[n] ?? 'th'}</sup>`;

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

    // Drift charge / boost badge.
    const charge = kart.boost > 0 ? 'boost' : kart.drift.dir !== 0 ? `drift-${kart.drift.level}` : '';
    if (ui.charge.dataset.state !== charge) {
      ui.charge.dataset.state = charge;
      ui.charge.textContent = charge === 'boost' ? 'BOOST' : charge ? 'DRIFT' : '';
    }

    // Race info: place, lap, lap time, best lap. Late joiners sit this race out.
    const racer = race.racers.get(slot);
    ui.chip.classList.toggle('spectating', !racer);
    ui.chip.style.order = racer ? places.get(slot) ?? 9 : 9;
    if (!racer) {
      ui.lap.textContent = race.phase === 'practice' ? '' : 'next race';
      continue;
    }
    ui.place.innerHTML = racer.dnf ? 'DNF' : ordinal(places.get(slot));
    ui.lap.textContent = racer.finishTime !== null ? 'Finished' : `Lap ${race.currentLap(slot)}/${race.rules.laps}`;
    ui.laptime.textContent = formatTime(racer.finishTime ?? race.currentLapTime(slot));
    ui.best.textContent = `best ${formatTime(racer.bestLap)}`;
  }
}

let places = new Map(); // slot -> current place, refreshed every frame

// ---------- Race screens ----------

function renderRacePanel() {
  const panel = $('race-panel');
  const title = $('race-title');
  const sub = $('race-sub');
  const button = $('start-race');
  const recordText = record ? `Lap record ${formatTime(record.time)} (${record.name})` : 'No lap record yet';
  document.body.classList.toggle('practice', race.phase === 'practice');

  if (race.phase === 'practice') {
    panel.hidden = false;
    title.textContent = `Practice · ${track.name}`;
    sub.textContent = `Space starts a ${race.rules.laps}-lap race · ${recordText}`;
    button.hidden = false;
  } else if (race.phase === 'countdown') {
    panel.hidden = true;
  } else if (race.phase === 'racing') {
    panel.hidden = false;
    const leader = race.standings()[0];
    title.innerHTML = `Race · <span class="clock">${formatTime(race.time)}</span>`;
    sub.textContent = leader ? `Leader ${playerInfo(leader.slot).name} · lap ${race.currentLap(leader.slot)}/${race.rules.laps}` : '';
    button.hidden = true;
  } else {
    panel.hidden = true;
  }
}

let goUntil = 0;

function renderCountdown(now) {
  const el = $('countdown');
  if (race.phase === 'countdown') {
    el.hidden = false;
    el.classList.remove('go');
    el.textContent = String(Math.ceil(race.countdown));
  } else if (now < goUntil) {
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

/** Alerts: "FINAL LAP" for a moment, "WRONG WAY" while it lasts. Keyed so they don't flicker. */
const timedAlerts = new Map(); // key -> { text, color, until }

function renderAlerts(now) {
  const wanted = new Map();
  for (const [key, a] of timedAlerts) {
    if (now < a.until) wanted.set(key, { ...a, kind: 'notice' });
    else timedAlerts.delete(key);
  }
  if (race.phase === 'racing') {
    for (const r of race.racers.values()) {
      if (r.wrongWay && r.finishTime === null) {
        wanted.set(`wrong-${r.slot}`, { text: `${playerInfo(r.slot).name} · wrong way`, kind: 'wrong-way' });
      }
    }
  }
  const box = $('alerts');
  for (const el of [...box.children]) if (!wanted.has(el.dataset.key)) el.remove();
  for (const [key, a] of wanted) {
    if (box.querySelector(`[data-key="${key}"]`)) continue;
    const el = document.createElement('div');
    el.className = `alert ${a.kind}`;
    el.dataset.key = key;
    if (a.color) el.style.setProperty('--player', a.color);
    el.textContent = a.text;
    box.append(el);
  }
}

function toast(html, color) {
  const el = document.createElement('div');
  el.className = 'toast';
  if (color) el.style.setProperty('--player', color);
  el.innerHTML = html;
  $('toasts').append(el);
  setTimeout(() => el.remove(), 4000);
}

function handleRaceEvents(now) {
  for (const e of raceEvents.splice(0)) {
    const who = e.slot ? playerInfo(e.slot) : null;
    if (e.type === 'go') {
      goUntil = now + 800;
      const el = $('countdown');
      el.textContent = 'GO!';
      el.classList.remove('go');
      void el.offsetWidth; // restart the animation
      el.classList.add('go');
    } else if (e.type === 'lap') {
      if (!record || e.lapTime < record.time) {
        const first = !record;
        record = { time: e.lapTime, name: who.name };
        saveRecord(record);
        if (!first) toast(`New lap record! ${who.name} <b>${formatTime(e.lapTime)}</b>`, who.color);
      }
      if (e.lap < race.rules.laps) toast(`${who.name} lap ${e.lap} <b>${formatTime(e.lapTime)}</b>`, who.color);
      if (e.lap === race.rules.laps - 1) {
        timedAlerts.set(`final-${e.slot}`, { text: `${who.name} · final lap`, color: who.color, until: now + 2000 });
      }
    } else if (e.type === 'finish') {
      toast(`${who.name} finishes ${ordinal(e.place)} <b>${formatTime(e.time)}</b>`, who.color);
    } else if (e.type === 'results') {
      showResults();
    }
  }
}

function showResults() {
  const rows = race.standings().map((r) => {
    const p = playerInfo(r.slot);
    const isRecord = record && r.bestLap !== null && Math.abs(r.bestLap - record.time) < 1e-9;
    return (
      `<tr><td class="pos">${r.dnf ? '–' : ordinal(r.place)}</td>` +
      `<td><span class="badge" style="--player:${p.color}">${p.name}</span></td>` +
      `<td class="time">${r.dnf ? 'DNF' : formatTime(r.finishTime)}</td>` +
      `<td class="time ${isRecord ? 'record' : ''}">${formatTime(r.bestLap)}${isRecord ? ' · record' : ''}</td></tr>`
    );
  });
  const winner = race.standings()[0];
  $('results-title').textContent = winner && !winner.dnf ? `${playerInfo(winner.slot).name} wins!` : 'Results';
  $('results-rows').innerHTML = rows.join('');
  $('results').hidden = false;
}

function renderMinimap() {
  const leader = race.phase === 'racing' ? race.standings()[0]?.slot : null;
  minimap.draw(
    [...physics.karts.entries()].map(([slot, kart]) => ({
      x: kart.x,
      z: kart.z,
      color: playerInfo(slot).color,
      highlight: slot === leader,
    })),
  );
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
    world.updateKart(slot, interpolate(kart, alpha), kart, lastInput.get(slot)?.steer ?? 0, dt);
  }
  world.updateCamera(dt, now / 1000);
  world.render();

  places = new Map(race.standings().map((r) => [r.slot, r.place]));
  handleRaceEvents(now);
  feedback.handle(physicsEvents.splice(0), now);
  for (const [slot, kart] of physics.karts) feedback.drift(slot, kart);
  feedback.flush();
  $('speedlines').style.opacity = world.speedLines.toFixed(2);
  renderRacePanel();
  renderCountdown(now);
  renderAlerts(now);
  renderMinimap();
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

// Development only: poke at the game from the browser console, e.g. kart.race.standings().
if (import.meta.env.DEV) window.kart = { race, physics, track, input, world, params, feedback };
