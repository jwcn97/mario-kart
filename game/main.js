/**
 * Game screen (Phase 2): opens a room on the relay, shows how to join, and
 * draws each connected phone's live steering plus connection stats.
 *
 * No racing yet. In Phase 3 the `players` map below feeds the karts.
 */
import QRCode from 'qrcode';
import { ERRORS, MAX_PLAYERS, PLAYERS } from '../shared/protocol.js';
import { createConnection } from '../shared/net.js';
import { relayUrl } from '../shared/relay-url.js';

const ROOM_KEY = 'kart.game.room'; // remembers our room across reloads
const STALE_INPUT_MS = 500;

const $ = (id) => document.getElementById(id);

// ---------- State ----------

/** slot -> player state. Every slot always exists; `present` says whether someone's in it. */
const players = new Map(
  PLAYERS.map((p) => [
    p.slot,
    { ...p, present: false, connected: false, steer: 0, lastInputAt: 0, inputTimes: [], phoneRtt: null },
  ]),
);

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
      break;
    }

    case 'player-removed': {
      const p = players.get(msg.slot);
      if (p) Object.assign(p, { present: false, connected: false, steer: 0, phoneRtt: null, inputTimes: [] });
      break;
    }

    case 'input': {
      const p = players.get(msg.slot);
      if (!p) return;
      const now = performance.now();
      p.steer = msg.steer;
      p.lastInputAt = now;
      p.inputTimes.push(now);
      if (typeof msg.rtt === 'number') p.phoneRtt = msg.rtt;
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

// When the laptop wakes up or the tab comes back, check the connection straight away.
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
  $('join-warning').textContent =
    'This computer has no Wi-Fi address, so phones can’t reach it. Connect to the same Wi-Fi as the phones.';
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

if (room) showJoinInfo(room.code); // show the remembered code immediately while we reconnect

// ---------- Player cards ----------

const cards = new Map();
const template = $('player-card');

for (const p of PLAYERS) {
  const card = template.content.firstElementChild.cloneNode(true);
  card.style.setProperty('--player', p.color);
  card.querySelector('.badge').textContent = p.name;
  card.querySelector('.empty-hint').textContent = `Scan the QR code to join as ${p.name}`;
  $('players').append(card);
  cards.set(p.slot, {
    card,
    status: card.querySelector('.status'),
    rotor: card.querySelector('.rotor'),
    value: card.querySelector('.value'),
    fill: card.querySelector('.bar-fill'),
    rate: card.querySelector('.rate'),
    phoneRtt: card.querySelector('.phone-rtt'),
    latency: card.querySelector('.latency'),
    age: card.querySelector('.age'),
  });
}

const signed = (n) => {
  const r = Math.round(n * 100) / 100;
  return `${r < 0 ? '−' : '+'}${Math.abs(r).toFixed(2)}`;
};
const ms = (n) => (n === null || n === undefined ? '–' : `${Math.round(n)} ms`);

function renderServerChip() {
  const chip = $('server-chip');
  const status = conn.status;
  const text = {
    connecting: 'connecting…',
    connected: `relay ${ms(conn.rtt)}`,
    reconnecting: 'reconnecting…',
    stopped: 'disconnected',
  }[status];
  chip.textContent = text;
  chip.className = `chip ${status === 'connected' ? 'good' : 'warn'}`;
}

function renderPlayer(p, now) {
  const ui = cards.get(p.slot);
  while (p.inputTimes.length && now - p.inputTimes[0] > 1000) p.inputTimes.shift();

  ui.card.classList.toggle('empty', !p.present);
  ui.card.classList.toggle('live', p.present && p.connected);
  ui.card.classList.toggle('offline', p.present && !p.connected);
  if (!p.present) {
    ui.status.textContent = 'Open slot';
    return;
  }

  const age = p.lastInputAt ? now - p.lastInputAt : null;
  const stalled = p.connected && (age === null || age > STALE_INPUT_MS);
  ui.status.textContent = !p.connected ? 'Reconnecting…' : stalled ? 'Connected · waiting for input' : 'Connected';

  ui.rotor.setAttribute('transform', `rotate(${(p.steer * 90).toFixed(2)})`);
  ui.value.textContent = signed(p.steer);
  const width = Math.abs(p.steer) * 50;
  ui.fill.style.left = `${p.steer >= 0 ? 50 : 50 - width}%`;
  ui.fill.style.width = `${width}%`;

  ui.rate.textContent = `${p.inputTimes.length}/s`;
  ui.phoneRtt.textContent = ms(p.phoneRtt);
  // One-way time ≈ half of each round trip: phone -> server, then server -> this screen.
  const latency = p.phoneRtt !== null && conn.rtt !== null ? p.phoneRtt / 2 + conn.rtt / 2 : null;
  ui.latency.textContent = latency === null ? '–' : `≈ ${Math.round(latency)} ms`;
  ui.latency.classList.toggle('bad', latency !== null && latency > 50);
  ui.age.textContent = age === null ? '–' : age > 5000 ? `${Math.round(age / 1000)} s ago` : `${Math.round(age)} ms ago`;
  ui.age.classList.toggle('bad', stalled);
}

function renderFooter() {
  const present = [...players.values()].filter((p) => p.present);
  const live = present.filter((p) => p.connected).length;
  const rate = present.reduce((sum, p) => sum + p.inputTimes.length, 0);
  $('footer').textContent =
    `room ${room?.code ?? '····'} · ${live}/${MAX_PLAYERS} phones connected · ${rate} input msg/s · relay ${relayUrl()}`;
}

function renderBanner() {
  const banner = $('banner');
  const message = fatal ?? (conn.status === 'reconnecting' ? 'Lost the relay server. Reconnecting…' : null);
  banner.hidden = !message;
  if (message) banner.textContent = message;
}

function frame() {
  const now = performance.now();
  for (const p of players.values()) renderPlayer(p, now);
  renderServerChip();
  renderFooter();
  renderBanner();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
