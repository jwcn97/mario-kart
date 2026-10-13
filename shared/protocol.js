/**
 * Things the relay server, the game screen and the phones must agree on.
 * Imported by both Node (server) and the browser, so: no browser or Node APIs here.
 *
 * Every message is a JSON object with a `type`. The full list, with examples,
 * is in docs/phase-2-networking.md.
 */

export const MAX_PLAYERS = 4;

/** Player slots are numbered 1..4; each has a fixed colour and name. */
export const PLAYERS = Object.freeze([
  { slot: 1, name: 'P1', color: '#ff5a4f' }, // red
  { slot: 2, name: 'P2', color: '#4da3ff' }, // blue
  { slot: 3, name: 'P3', color: '#4fd18b' }, // green
  { slot: 4, name: 'P4', color: '#ffc400' }, // yellow
]);

export const playerInfo = (slot) => PLAYERS.find((p) => p.slot === slot);

/** Room codes: 4 letters, skipping I and O so nobody confuses them with 1 and 0. */
export const ROOM_CODE_LENGTH = 4;
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Uppercase, strip spaces; returns null unless it's a well-formed code. */
export function normalizeRoomCode(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase().replace(/\s+/g, '');
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

/** Path the WebSocket server listens on, next to the web pages. */
export const RELAY_PATH = '/ws';

/** How long a slot or room is kept after its connection drops, so reconnects land back in place. */
export const PLAYER_GRACE_MS = 60_000;
export const HOST_GRACE_MS = 60_000;

/** Reasons the server sends in `{ type: 'error', reason }`. */
export const ERRORS = Object.freeze({
  NO_ROOM: 'no-room', // that code isn't open (yet)
  ROOM_FULL: 'room-full', // already 4 players
  REPLACED: 'replaced', // same player or host connected again elsewhere
  ROOM_CLOSED: 'room-closed', // the game screen left and didn't come back
});

/** Phones send input at this rate (messages per second). */
export const INPUT_RATE_HZ = 60;
