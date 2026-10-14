/**
 * Relay: the rules for rooms, players and messages, with no networking code.
 *
 * A "connection" is any object with `send(message)` and `close(code, reason)`.
 * server/attach.js wraps real WebSockets in that shape; the tests use fakes.
 * Time comes from an injectable clock, so grace periods can be tested instantly.
 *
 *   game screen --host--> creates a room, gets a 4-letter code
 *   phone       --join--> takes a free player slot (1..4) in that room
 *   phone       --input-> forwarded to the room's game screen, tagged with the slot
 *   game screen --to-player-> forwarded to one phone (vibration, drift charge…)
 *
 * Dropped connections keep their room/slot for a grace period, so a phone that
 * locks or a game screen that reloads lands back where it was.
 */
import {
  ERRORS,
  HOST_GRACE_MS,
  MAX_PLAYERS,
  PLAYER_GRACE_MS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  normalizeRoomCode,
  playerInfo,
} from '../shared/protocol.js';

const isFiniteNumber = (x) => typeof x === 'number' && Number.isFinite(x);
const isId = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(x);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export class Relay {
  constructor({
    now = Date.now,
    random = Math.random,
    playerGraceMs = PLAYER_GRACE_MS,
    hostGraceMs = HOST_GRACE_MS,
    log = () => {},
  } = {}) {
    this.now = now;
    this.random = random;
    this.playerGraceMs = playerGraceMs;
    this.hostGraceMs = hostGraceMs;
    this.log = log;
    this.rooms = new Map(); // code -> room
    this.sessions = new Map(); // connection -> { role, room, slot }
  }

  // ---------- Connection lifecycle (called by the transport) ----------

  connect(conn) {
    this.sessions.set(conn, { role: null, room: null, slot: null });
  }

  receive(conn, msg) {
    const session = this.sessions.get(conn);
    if (!session || !msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'ping':
        if (isFiniteNumber(msg.t)) conn.send({ type: 'pong', t: msg.t });
        return;
      case 'host':
        if (session.role === null) this.#host(conn, session, msg);
        return;
      case 'join':
        if (session.role === null) this.#join(conn, session, msg);
        return;
      case 'input':
        if (session.role === 'player') this.#input(session, msg);
        return;
      case 'to-player':
        if (session.role === 'host') this.#toPlayer(session, msg);
        return;
      default:
      // Unknown messages are ignored: never trust what a client sends.
    }
  }

  disconnect(conn) {
    const session = this.sessions.get(conn);
    this.sessions.delete(conn);
    if (!session?.room) return;
    const { room } = session;

    if (session.role === 'host' && room.host === conn) {
      room.host = null;
      room.hostLeftAt = this.now();
      this.#toPlayers(room, { type: 'host-status', connected: false });
      this.log(`room ${room.code}: game screen disconnected`);
    }

    if (session.role === 'player') {
      const player = room.players.get(session.slot);
      if (player && player.conn === conn) {
        player.conn = null;
        player.leftAt = this.now();
        this.#toHost(room, this.#playerMessage(player));
        this.log(`room ${room.code}: P${player.slot} disconnected`);
      }
    }
  }

  /** Expire slots and rooms whose grace period ran out. Call every few seconds. */
  sweep() {
    const now = this.now();
    for (const room of this.rooms.values()) {
      for (const player of room.players.values()) {
        if (player.conn === null && now - player.leftAt >= this.playerGraceMs) {
          room.players.delete(player.slot);
          this.#toHost(room, { type: 'player-removed', slot: player.slot });
          this.log(`room ${room.code}: P${player.slot} slot freed`);
        }
      }
      if (room.host === null && now - room.hostLeftAt >= this.hostGraceMs) {
        for (const player of room.players.values()) {
          if (player.conn) this.#kick(player.conn, ERRORS.ROOM_CLOSED);
        }
        this.rooms.delete(room.code);
        this.log(`room ${room.code}: closed`);
      }
    }
  }

  // ---------- Message handlers ----------

  #host(conn, session, msg) {
    const wanted = normalizeRoomCode(msg.code);
    const token = isId(msg.token) ? msg.token : null;
    let room = wanted ? this.rooms.get(wanted) : undefined;

    if (room && room.token !== token) {
      room = undefined; // someone else's room: don't hand it over
    } else if (!room && wanted && token && !this.rooms.has(wanted)) {
      // The server restarted and forgot the room: recreate it under the same code,
      // so phones that still hold that code can rejoin.
      room = this.#createRoom(wanted, token);
    }
    room ??= this.#createRoom(this.#freshCode(), this.#freshToken());

    if (room.host && room.host !== conn) this.#kick(room.host, ERRORS.REPLACED);
    room.host = conn;
    room.hostLeftAt = null;
    Object.assign(session, { role: 'host', room });

    conn.send({ type: 'room', code: room.code, token: room.token });
    for (const player of room.players.values()) conn.send(this.#playerMessage(player));
    this.#toPlayers(room, { type: 'host-status', connected: true });
    this.log(`room ${room.code}: game screen connected`);
  }

  #join(conn, session, msg) {
    const code = normalizeRoomCode(msg.code);
    const room = code ? this.rooms.get(code) : undefined;
    if (!room) return conn.send({ type: 'error', reason: ERRORS.NO_ROOM });
    if (!isId(msg.playerId)) return;

    // Same phone coming back (reconnect, reload): give it its old slot.
    let player = [...room.players.values()].find((p) => p.playerId === msg.playerId);
    if (player) {
      if (player.conn && player.conn !== conn) this.#kick(player.conn, ERRORS.REPLACED);
    } else {
      // A phone may ask for the slot it had before a server restart, so colours don't swap.
      const wanted = Number.isInteger(msg.slot) && msg.slot >= 1 && msg.slot <= MAX_PLAYERS ? msg.slot : null;
      const slot = wanted && !room.players.has(wanted) ? wanted : this.#freeSlot(room);
      if (slot === null) return conn.send({ type: 'error', reason: ERRORS.ROOM_FULL });
      player = { slot, playerId: msg.playerId, conn: null, leftAt: null };
      room.players.set(slot, player);
    }

    player.conn = conn;
    player.leftAt = null;
    Object.assign(session, { role: 'player', room, slot: player.slot });

    const { name, color } = playerInfo(player.slot);
    conn.send({ type: 'joined', code: room.code, slot: player.slot, name, color });
    conn.send({ type: 'host-status', connected: room.host !== null });
    this.#toHost(room, this.#playerMessage(player));
    this.log(`room ${room.code}: P${player.slot} connected`);
  }

  #input(session, msg) {
    if (!isFiniteNumber(msg.steer)) return;
    const out = {
      type: 'input',
      slot: session.slot,
      steer: clamp(msg.steer, -1, 1),
      seq: Number.isInteger(msg.seq) ? msg.seq : 0,
      gas: msg.gas === true,
      brake: msg.brake === true,
      drift: msg.drift === true,
    };
    if (isFiniteNumber(msg.rtt)) out.rtt = clamp(Math.round(msg.rtt), 0, 10_000);
    this.#toHost(session.room, out);
  }

  /** Game screen -> one phone. The relay doesn't look inside `data`; the phone does. */
  #toPlayer(session, msg) {
    if (!Number.isInteger(msg.slot)) return;
    if (!msg.data || typeof msg.data !== 'object' || Array.isArray(msg.data)) return;
    session.room.players.get(msg.slot)?.conn?.send({ type: 'from-game', data: msg.data });
  }

  // ---------- Helpers ----------

  #createRoom(code, token) {
    const room = { code, token, host: null, hostLeftAt: null, players: new Map() };
    this.rooms.set(code, room);
    return room;
  }

  #freshCode() {
    for (;;) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
        code += ROOM_CODE_ALPHABET[Math.floor(this.random() * ROOM_CODE_ALPHABET.length)];
      }
      if (!this.rooms.has(code)) return code;
    }
  }

  #freshToken() {
    let token = '';
    while (token.length < 24) token += Math.floor(this.random() * 36 ** 6).toString(36);
    return token.slice(0, 24);
  }

  #freeSlot(room) {
    for (let slot = 1; slot <= MAX_PLAYERS; slot++) if (!room.players.has(slot)) return slot;
    return null;
  }

  #playerMessage(player) {
    const { name, color } = playerInfo(player.slot);
    return { type: 'player', slot: player.slot, name, color, connected: player.conn !== null };
  }

  #toHost(room, msg) {
    room.host?.send(msg);
  }

  #toPlayers(room, msg) {
    for (const player of room.players.values()) player.conn?.send(msg);
  }

  #kick(conn, reason) {
    conn.send({ type: 'error', reason });
    // Forget the session first so the close doesn't count as a disconnect.
    this.sessions.delete(conn);
    conn.close(4000, reason);
  }
}
