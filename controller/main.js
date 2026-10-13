/**
 * Phone controller page.
 *
 * Flow: tap Start -> ask for motion permission (iOS) -> listen to
 * `deviceorientation` -> turn each reading into a steering value with
 * SteeringProcessor (Phase 1) -> join the game screen's room and stream the
 * value to it 60 times a second (Phase 2) -> draw it every frame.
 *
 * No sensor (e.g. on a laptop)? The arrow keys or A/D simulate tilting, so the
 * page is still testable at a desk.
 */
import { DEFAULT_SETTINGS, SteeringProcessor, readWheelAngle } from './steering.js';
import { ERRORS, INPUT_RATE_HZ, normalizeRoomCode } from '../shared/protocol.js';
import { createConnection } from '../shared/net.js';
import { relayUrl } from '../shared/relay-url.js';

const SETTINGS_KEY = 'kart.controller.settings.v1';
const PLAYER_ID_KEY = 'kart.controller.playerId';
const SENSOR_TIMEOUT_MS = 1500;

const $ = (id) => document.getElementById(id);
const el = {
  start: $('start'),
  startBtn: $('start-btn'),
  startError: $('start-error'),
  roomInput: $('room-input'),
  play: $('play'),
  recenterBtn: $('recenter-btn'),
  tuneBtn: $('tune-btn'),
  chipSource: $('chip-source'),
  chipNet: $('chip-net'),
  chipAwake: $('chip-awake'),
  rotor: $('wheel-rotor'),
  direction: $('direction'),
  value: $('value'),
  barFill: $('bar-fill'),
  notice: $('notice'),
  debug: $('debug'),
  sheet: $('sheet'),
  sheetClose: $('sheet-close'),
  sliders: $('sliders'),
  invert: $('invert'),
  resetBtn: $('reset-btn'),
};

// ---------- Settings (remembered on this phone) ----------

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return { ...DEFAULT_SETTINGS, ...saved };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or storage blocked: settings just won't persist.
  }
}

const processor = new SteeringProcessor(loadSettings());

// ---------- Room (Phase 2) ----------

/**
 * Who this phone is, so a reconnect or reload gets the same player slot back.
 * Kept per tab (sessionStorage), so two tabs on one laptop count as two players.
 */
function loadPlayerId() {
  const fresh = () =>
    crypto.randomUUID?.() ?? `p${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  try {
    let id = sessionStorage.getItem(PLAYER_ID_KEY);
    if (!id) {
      id = fresh();
      sessionStorage.setItem(PLAYER_ID_KEY, id);
    }
    return id;
  } catch {
    return fresh();
  }
}

const net = {
  code: null, // room we're in, or null for steering practice only
  conn: null,
  player: null, // { slot, name, color } once joined
  hostConnected: null,
  problem: null, // message to show when something's wrong with the room
  noRoomCount: 0,
  seq: 0,
};

// The QR code on the game screen opens /controller/?room=ABCD.
el.roomInput.value = normalizeRoomCode(new URLSearchParams(location.search).get('room') ?? '') ?? '';
el.roomInput.addEventListener('input', () => {
  el.roomInput.value = el.roomInput.value.toUpperCase().replace(/[^A-Z]/g, '');
});

function joinRoom(code) {
  net.code = code;
  const playerId = loadPlayerId();
  net.conn = createConnection({
    url: relayUrl(),
    // Sent on every (re)connect. Asking for our previous slot keeps our colour if the server restarted.
    hello: () => ({ type: 'join', code, playerId, slot: net.player?.slot }),
    onMessage: handleRoomMessage,
  });
}

function handleRoomMessage(msg) {
  switch (msg.type) {
    case 'joined':
      net.player = { slot: msg.slot, name: msg.name, color: msg.color };
      net.noRoomCount = 0;
      net.problem = null;
      document.body.style.setProperty('--player', msg.color);
      break;
    case 'host-status':
      net.hostConnected = msg.connected;
      break;
    case 'error':
      handleRoomError(msg.reason);
      break;
  }
}

function handleRoomError(reason) {
  if (reason === ERRORS.NO_ROOM) {
    // Maybe a typo, or the game screen is still reconnecting: keep trying.
    net.noRoomCount++;
    if (net.noRoomCount >= 2) net.problem = `Room ${net.code} not found. Check the code on the game screen.`;
    net.conn.retry(2000);
    return;
  }
  net.player = null;
  net.problem =
    {
      [ERRORS.ROOM_FULL]: `Room ${net.code} is full (4 players).`,
      [ERRORS.REPLACED]: 'This controller was opened in another tab, so this one stopped.',
      [ERRORS.ROOM_CLOSED]: 'The game screen closed the room. Scan its QR code again to rejoin.',
    }[reason] ?? `The server said: ${reason}`;
  net.conn.stop();
}

/** Stream steering at a fixed rate, not on every sensor event: steady and predictable for the game. */
function sendInput() {
  if (!net.conn?.connected || !net.player) return;
  net.conn.send({
    type: 'input',
    steer: Math.round(processor.value * 1000) / 1000,
    seq: ++net.seq,
    rtt: net.conn.rtt === null ? undefined : Math.round(net.conn.rtt),
  });
}

// ---------- Live state ----------

const state = {
  playing: false,
  source: 'waiting', // 'waiting' | 'sensor' | 'keyboard'
  beta: null,
  gamma: null,
  screenAngle: 0,
  upright: 1,
  tooFlat: false,
  eventTimes: [],
  wakeLock: null,
  keys: { left: false, right: false },
  keyboardAngle: 0,
};

function currentScreenAngle() {
  const angle = screen.orientation?.angle ?? window.orientation ?? 0;
  return ((angle % 360) + 360) % 360;
}

// ---------- Starting: permission, fullscreen, wake lock ----------

function showStartError(message) {
  el.startError.textContent = message;
  el.startError.hidden = false;
}

async function enterFullscreenAndLockLandscape() {
  // Android Chrome: orientation lock only works in fullscreen. iPhone Safari supports neither,
  // so there the "turn your phone sideways" hint does the job instead.
  try {
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
    await screen.orientation?.lock?.('landscape');
  } catch {
    // Not supported here: fine.
  }
}

async function keepScreenAwake() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => {
      state.wakeLock = null;
    });
  } catch {
    state.wakeLock = null;
  }
}

el.startBtn.addEventListener('click', async () => {
  el.startError.hidden = true;

  const typed = el.roomInput.value.trim();
  const code = normalizeRoomCode(typed);
  if (typed && !code) {
    showStartError('Room codes are 4 letters, like KART. Check the game screen.');
    return;
  }

  if (!window.isSecureContext) {
    showStartError(
      'Motion sensors only work on https:// pages. Open the https link printed by "npm run dev" instead.',
    );
    return;
  }

  // Both calls must start inside this tap, before any await, or browsers refuse them.
  const askPermission =
    typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function'
      ? DeviceOrientationEvent.requestPermission() // iOS 13+
      : Promise.resolve('granted'); // Android and desktop don't ask
  enterFullscreenAndLockLandscape();

  let permission;
  try {
    permission = await askPermission;
  } catch (err) {
    showStartError(`Couldn't ask for motion access: ${err.message}`);
    return;
  }
  if (permission !== 'granted') {
    showStartError(
      'Motion access was denied. Reload the page and tap Allow. If it no longer asks, clear this site’s data in your browser settings and try again.',
    );
    return;
  }

  beginPlaying(code);
});

function beginPlaying(code) {
  state.playing = true;
  document.body.classList.add('playing');
  el.start.hidden = true;
  el.play.hidden = false;

  processor.reset(); // the first reading becomes "straight ahead"
  window.addEventListener('deviceorientation', onOrientation);
  keepScreenAwake();

  setTimeout(() => {
    if (state.source === 'waiting') state.source = 'keyboard';
  }, SENSOR_TIMEOUT_MS);

  if (code) joinRoom(code);
  setInterval(sendInput, 1000 / INPUT_RATE_HZ);
  requestAnimationFrame(frame);
}

// Unlocking the phone or switching back to the browser: re-check everything straight away.
document.addEventListener('visibilitychange', () => {
  if (!state.playing || document.visibilityState !== 'visible') return;
  if (!state.wakeLock) keepScreenAwake();
  net.conn?.reconnectNow();
});
window.addEventListener('online', () => net.conn?.reconnectNow());

// ---------- Sensor input ----------

function onOrientation(event) {
  if (event.beta == null || event.gamma == null) return; // some laptops fire empty events

  if (state.source !== 'sensor') {
    state.source = 'sensor';
    document.body.classList.add('has-sensor');
  }

  const now = event.timeStamp || performance.now();
  state.eventTimes.push(now);
  while (state.eventTimes.length && now - state.eventTimes[0] > 1000) state.eventTimes.shift();

  state.beta = event.beta;
  state.gamma = event.gamma;
  state.screenAngle = currentScreenAngle();

  const reading = readWheelAngle({ beta: event.beta, gamma: event.gamma, screenAngleDeg: state.screenAngle });
  state.upright = reading.upright;
  state.tooFlat = reading.angleDeg === null;
  if (state.tooFlat) processor.release(now);
  else processor.update(reading.angleDeg, now);
}

function onScreenRotated() {
  // A new orientation means a new "straight ahead": take it from the next reading.
  processor.reset();
}
screen.orientation?.addEventListener?.('change', onScreenRotated);
window.addEventListener('orientationchange', onScreenRotated);

// ---------- Keyboard fallback (desk testing) ----------

const KEY_MAP = { ArrowLeft: 'left', a: 'left', A: 'left', ArrowRight: 'right', d: 'right', D: 'right' };

window.addEventListener('keydown', (e) => {
  if (KEY_MAP[e.key]) state.keys[KEY_MAP[e.key]] = true;
  if (e.key === 'c' || e.key === 'C') processor.recenter();
});
window.addEventListener('keyup', (e) => {
  if (KEY_MAP[e.key]) state.keys[KEY_MAP[e.key]] = false;
});

function tickKeyboard(dtMs, now) {
  // Ease a pretend wheel angle toward a little past full lock, like turning a real wheel.
  const target = (state.keys.right - state.keys.left) * processor.settings.maxAngleDeg * 1.2;
  state.keyboardAngle += (target - state.keyboardAngle) * Math.min(1, dtMs / 120);
  processor.update(state.keyboardAngle, now);
}

// ---------- Drawing ----------

function setNotice(text) {
  el.notice.hidden = !text;
  if (text && el.notice.textContent !== text) el.notice.textContent = text;
}

function currentNotice() {
  if (net.problem) return net.problem;
  if (state.source === 'sensor' && state.tooFlat) return 'Lift the phone up: it’s lying too flat to read the wheel.';
  if (state.source === 'keyboard') return 'No motion sensor found. Use ← → or A / D to test steering.';
  return null;
}

function renderNetChip() {
  const chip = el.chipNet;
  chip.style.removeProperty('color');
  chip.style.removeProperty('border-color');
  if (!net.code) return setChip(chip, 'practice · no room');
  if (!net.conn || net.conn.status === 'stopped') return setChip(chip, 'not connected', 'warn');
  if (net.problem && !net.player) return setChip(chip, 'not joined', 'warn');
  if (!net.conn.connected) return setChip(chip, `${net.conn.status}…`, 'warn');
  if (!net.player) return setChip(chip, `joining ${net.code}…`, 'warn');
  if (!net.hostConnected) return setChip(chip, `${net.player.name} · waiting for screen`, 'warn');

  setChip(chip, `${net.player.name} · ${net.conn.rtt === null ? '–' : Math.round(net.conn.rtt)} ms`);
  chip.style.color = net.player.color;
  chip.style.borderColor = net.player.color;
}

const fmt = (n, digits = 1) => (n == null ? '–' : n.toFixed(digits));
const signed = (n) => {
  const r = Math.round(n * 100) / 100; // so a tiny -0.001 shows as +0.00, not −0.00
  return `${r < 0 ? '−' : '+'}${Math.abs(r).toFixed(2)}`;
};

function setChip(chip, text, tone) {
  chip.textContent = text;
  chip.classList.toggle('good', tone === 'good');
  chip.classList.toggle('warn', tone === 'warn');
}

function render() {
  const v = processor.value;

  el.rotor.setAttribute('transform', `rotate(${(v * 90).toFixed(2)})`);
  el.value.textContent = signed(v);
  el.direction.textContent = Math.abs(v) < 0.02 ? 'Straight' : v > 0 ? 'Right' : 'Left';

  const width = Math.abs(v) * 50;
  el.barFill.style.left = `${v >= 0 ? 50 : 50 - width}%`;
  el.barFill.style.width = `${width}%`;

  const sourceLabel = { waiting: 'waiting for sensor', sensor: 'gyro', keyboard: 'keyboard' }[state.source];
  setChip(el.chipSource, sourceLabel, state.source === 'sensor' ? 'good' : 'warn');
  setChip(el.chipAwake, state.wakeLock ? 'screen stays on' : 'screen may sleep', state.wakeLock ? 'good' : undefined);
  renderNetChip();
  setNotice(currentNotice());

  el.debug.textContent =
    `sensor ${state.eventTimes.length} Hz  beta ${fmt(state.beta)}°  gamma ${fmt(state.gamma)}°  screen ${state.screenAngle}°  upright ${fmt(state.upright, 2)}\n` +
    `wheel ${fmt(processor.rawDeg)}°  centre ${fmt(processor.centerDeg)}°  steer angle ${fmt(processor.angleDeg)}°`;
}

let lastFrame = performance.now();
function frame(now) {
  const dt = now - lastFrame;
  lastFrame = now;
  if (state.source === 'keyboard') tickKeyboard(dt, now);
  render();
  requestAnimationFrame(frame);
}

// ---------- Buttons and the tuning sheet ----------

el.recenterBtn.addEventListener('click', () => processor.recenter());

const SLIDERS = [
  { key: 'deadZoneDeg', label: 'Dead zone', min: 0, max: 15, step: 0.5, unit: '°', hint: 'Ignore wobbles smaller than this.' },
  { key: 'maxAngleDeg', label: 'Full-lock angle', min: 10, max: 90, step: 1, unit: '°', hint: 'Tilt needed for full steering.' },
  { key: 'smoothingMs', label: 'Smoothing', min: 0, max: 300, step: 5, unit: ' ms', hint: 'Higher is steadier but laggier.' },
  { key: 'curve', label: 'Response curve', min: 0, max: 1, step: 0.05, unit: '', hint: '0 = linear, 1 = gentle near centre.' },
];

function updateSetting(patch) {
  processor.setSettings(patch);
  saveSettings(processor.settings);
}

const sliderInputs = {};

for (const s of SLIDERS) {
  const wrap = document.createElement('div');
  wrap.className = 'slider';

  const label = document.createElement('label');
  label.htmlFor = `slider-${s.key}`;
  label.textContent = s.label;
  const out = document.createElement('output');
  label.append(out);

  const input = document.createElement('input');
  input.type = 'range';
  input.id = `slider-${s.key}`;
  input.min = s.min;
  input.max = s.max;
  input.step = s.step;

  const hint = document.createElement('small');
  hint.textContent = s.hint;

  const show = () => {
    out.textContent = `${Number(input.value)}${s.unit}`;
  };
  input.addEventListener('input', () => {
    updateSetting({ [s.key]: Number(input.value) });
    show();
  });

  sliderInputs[s.key] = { input, show };
  wrap.append(label, input, hint);
  el.sliders.append(wrap);
}

function syncSheet() {
  for (const s of SLIDERS) {
    sliderInputs[s.key].input.value = processor.settings[s.key];
    sliderInputs[s.key].show();
  }
  el.invert.checked = processor.settings.invert;
}

el.invert.addEventListener('change', () => updateSetting({ invert: el.invert.checked }));
el.resetBtn.addEventListener('click', () => {
  updateSetting({ ...DEFAULT_SETTINGS });
  syncSheet();
});
el.tuneBtn.addEventListener('click', () => {
  syncSheet();
  el.sheet.hidden = false;
});
el.sheetClose.addEventListener('click', () => {
  el.sheet.hidden = true;
});
el.sheet.addEventListener('click', (e) => {
  if (e.target === el.sheet) el.sheet.hidden = true;
});
