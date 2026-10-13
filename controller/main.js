/**
 * Phone controller page (Phase 1).
 *
 * Flow: tap Start -> ask for motion permission (iOS) -> listen to
 * `deviceorientation` -> turn each reading into a steering value with
 * SteeringProcessor -> draw it every frame.
 *
 * No sensor (e.g. on a laptop)? The arrow keys or A/D simulate tilting, so the
 * page is still testable at a desk.
 */
import { DEFAULT_SETTINGS, SteeringProcessor, readWheelAngle } from './steering.js';

const SETTINGS_KEY = 'kart.controller.settings.v1';
const SENSOR_TIMEOUT_MS = 1500;

const $ = (id) => document.getElementById(id);
const el = {
  start: $('start'),
  startBtn: $('start-btn'),
  startError: $('start-error'),
  play: $('play'),
  recenterBtn: $('recenter-btn'),
  tuneBtn: $('tune-btn'),
  chipSource: $('chip-source'),
  chipRate: $('chip-rate'),
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

  beginPlaying();
});

function beginPlaying() {
  state.playing = true;
  document.body.classList.add('playing');
  el.start.hidden = true;
  el.play.hidden = false;

  processor.reset(); // the first reading becomes "straight ahead"
  window.addEventListener('deviceorientation', onOrientation);
  keepScreenAwake();

  setTimeout(() => {
    if (state.source === 'waiting') {
      state.source = 'keyboard';
      showNotice('No motion sensor found. Use ← → or A / D to test steering.');
    }
  }, SENSOR_TIMEOUT_MS);

  requestAnimationFrame(frame);
}

document.addEventListener('visibilitychange', () => {
  if (state.playing && document.visibilityState === 'visible' && !state.wakeLock) keepScreenAwake();
});

// ---------- Sensor input ----------

function onOrientation(event) {
  if (event.beta == null || event.gamma == null) return; // some laptops fire empty events

  if (state.source !== 'sensor') {
    state.source = 'sensor';
    document.body.classList.add('has-sensor');
    hideNotice();
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

function showNotice(text) {
  el.notice.textContent = text;
  el.notice.hidden = false;
}

function hideNotice() {
  el.notice.hidden = true;
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
  setChip(el.chipRate, `${state.eventTimes.length} Hz`, state.eventTimes.length >= 20 ? 'good' : undefined);
  setChip(el.chipAwake, state.wakeLock ? 'screen stays on' : 'screen may sleep', state.wakeLock ? 'good' : undefined);

  if (state.source === 'sensor') {
    if (state.tooFlat) showNotice('Lift the phone up: it’s lying too flat to read the wheel.');
    else hideNotice();
  }

  el.debug.textContent =
    `beta ${fmt(state.beta)}°  gamma ${fmt(state.gamma)}°  screen ${state.screenAngle}°  upright ${fmt(state.upright, 2)}\n` +
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
