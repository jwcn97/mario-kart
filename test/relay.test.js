import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Relay } from '../server/relay.js';
import { ERRORS, normalizeRoomCode } from '../shared/protocol.js';

/** A fake connection that records what it was sent. */
function fakeConn(name) {
  return {
    name,
    sent: [],
    closed: null,
    send(msg) {
      this.sent.push(msg);
    },
    close(code, reason) {
      this.closed = { code, reason };
    },
    last(type) {
      return this.sent.filter((m) => m.type === type).at(-1);
    },
    all(type) {
      return this.sent.filter((m) => m.type === type);
    },
  };
}

function setup() {
  let t = 0;
  const clock = {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
  const relay = new Relay({ now: clock.now, playerGraceMs: 1000, hostGraceMs: 2000 });
  const open = (name) => {
    const c = fakeConn(name);
    relay.connect(c);
    return c;
  };
  const host = (msg = {}) => {
    const c = open('host');
    relay.receive(c, { type: 'host', ...msg });
    return c;
  };
  const phone = (code, id) => {
    const c = open(id);
    relay.receive(c, { type: 'join', code, playerId: id });
    return c;
  };
  return { relay, clock, open, host, phone };
}

const ID = (n) => `player-${String(n).padStart(4, '0')}`;

test('room codes: normalised, 4 letters, no I or O', () => {
  assert.equal(normalizeRoomCode(' abcd '), 'ABCD');
  assert.equal(normalizeRoomCode('ABIO'), null);
  assert.equal(normalizeRoomCode('ABC'), null);
  assert.equal(normalizeRoomCode(42), null);
});

test('host gets a fresh room code and token', () => {
  const { host } = setup();
  const h = host();
  const room = h.last('room');
  assert.ok(normalizeRoomCode(room.code));
  assert.match(room.token, /^[a-z0-9]{24}$/);
});

test('phones take slots 1..4 with fixed colours; the 5th is turned away', () => {
  const { host, phone } = setup();
  const h = host();
  const { code } = h.last('room');
  const phones = [1, 2, 3, 4].map((n) => phone(code, ID(n)));
  assert.deepEqual(
    phones.map((p) => p.last('joined').slot),
    [1, 2, 3, 4],
  );
  assert.equal(phones[1].last('joined').color, '#4da3ff');
  assert.equal(h.all('player').length, 4);
  assert.equal(phones[0].last('host-status').connected, true);

  const fifth = phone(code, ID(5));
  assert.equal(fifth.last('error').reason, ERRORS.ROOM_FULL);
});

test('joining a code that does not exist says no-room', () => {
  const { phone } = setup();
  assert.equal(phone('ZZZZ', ID(1)).last('error').reason, ERRORS.NO_ROOM);
});

test('input is forwarded to the host, tagged with the slot and clamped', () => {
  const { relay, host, phone } = setup();
  const h = host();
  const p = phone(h.last('room').code, ID(1));
  relay.receive(p, { type: 'input', steer: 3, seq: 7, rtt: 21.6, gas: true, brake: 'yes', drift: true });
  assert.deepEqual(h.last('input'), { type: 'input', slot: 1, steer: 1, seq: 7, gas: true, brake: false, drift: true, rtt: 22 });
});

test('bad messages are ignored', () => {
  const { relay, host, phone, open } = setup();
  const h = host();
  const p = phone(h.last('room').code, ID(1));
  relay.receive(p, { type: 'input', steer: 'left' });
  relay.receive(p, { type: 'input', steer: NaN });
  relay.receive(p, null);
  relay.receive(p, { type: 'something-else' });
  assert.equal(h.all('input').length, 0);

  // A connection that never joined can't send input.
  const stranger = open('stranger');
  relay.receive(stranger, { type: 'input', steer: 0.5 });
  assert.equal(h.all('input').length, 0);

  // Join needs a sensible player id.
  const sneaky = open('sneaky');
  relay.receive(sneaky, { type: 'join', code: h.last('room').code, playerId: 'x' });
  assert.equal(sneaky.sent.length, 0);
});

test('ping is answered with pong carrying the same timestamp', () => {
  const { relay, open } = setup();
  const c = open('c');
  relay.receive(c, { type: 'ping', t: 123.5 });
  assert.deepEqual(c.last('pong'), { type: 'pong', t: 123.5 });
});

test('a phone that drops and comes back keeps its slot', () => {
  const { relay, host, phone } = setup();
  const h = host();
  const { code } = h.last('room');
  const p1 = phone(code, ID(1));
  phone(code, ID(2));

  relay.disconnect(p1);
  assert.deepEqual(h.last('player'), { type: 'player', slot: 1, name: 'P1', color: '#ff5a4f', connected: false });

  const again = phone(code, ID(1));
  assert.equal(again.last('joined').slot, 1);
  assert.equal(h.last('player').connected, true);
});

test('a dropped slot is freed after the grace period', () => {
  const { relay, clock, host, phone } = setup();
  const h = host();
  const { code } = h.last('room');
  const p1 = phone(code, ID(1));
  relay.disconnect(p1);

  clock.advance(999);
  relay.sweep();
  assert.equal(h.all('player-removed').length, 0);

  clock.advance(1);
  relay.sweep();
  assert.deepEqual(h.last('player-removed'), { type: 'player-removed', slot: 1 });
  assert.equal(phone(code, ID(9)).last('joined').slot, 1);
});

test('the same player opening a second tab replaces the first', () => {
  const { relay, host, phone } = setup();
  const h = host();
  const { code } = h.last('room');
  const first = phone(code, ID(1));
  const second = phone(code, ID(1));
  assert.equal(first.last('error').reason, ERRORS.REPLACED);
  assert.ok(first.closed);
  assert.equal(second.last('joined').slot, 1);

  // The old tab's close event must not mark the player as disconnected.
  const before = h.all('player').length;
  relay.disconnect(first);
  assert.equal(h.all('player').length, before);
});

test('phones hear when the game screen drops and returns', () => {
  const { relay, host, phone } = setup();
  const h = host();
  const { code, token } = h.last('room');
  const p = phone(code, ID(1));

  relay.disconnect(h);
  assert.equal(p.last('host-status').connected, false);

  const h2 = host({ code, token });
  assert.equal(h2.last('room').code, code);
  assert.equal(p.last('host-status').connected, true);
  // The returning screen is told who is already in the room.
  assert.equal(h2.last('player').slot, 1);
});

test('a wrong token cannot take over someone else’s room', () => {
  const { host } = setup();
  const h = host();
  const { code } = h.last('room');
  const intruder = host({ code, token: 'not-the-right-token-000' });
  assert.notEqual(intruder.last('room').code, code);
  assert.equal(h.closed, null);
});

test('after a server restart the game screen gets its old code back', () => {
  const { host } = setup(); // a fresh relay: no rooms
  const h = host({ code: 'KART', token: 'remembered-token-123456' });
  assert.equal(h.last('room').code, 'KART');
});

test('after a server restart phones can ask for their old slot back', () => {
  const { relay, host, open } = setup(); // fresh relay
  host({ code: 'KART', token: 'remembered-token-123456' });
  const join = (id, slot) => {
    const c = open(id);
    relay.receive(c, { type: 'join', code: 'KART', playerId: id, slot });
    return c.last('joined').slot;
  };
  assert.equal(join(ID(2), 2), 2); // the old P2 happens to reconnect first
  assert.equal(join(ID(1), 1), 1);
  assert.equal(join(ID(3), 2), 3); // taken: falls back to the next free slot
  assert.equal(join(ID(4), 99), 4); // nonsense is ignored
});

test('the room closes if the game screen stays away past its grace period', () => {
  const { relay, clock, host, phone } = setup();
  const h = host();
  const { code } = h.last('room');
  const p = phone(code, ID(1));
  relay.disconnect(h);

  clock.advance(2000);
  relay.sweep();
  assert.equal(p.last('error').reason, ERRORS.ROOM_CLOSED);
  assert.ok(p.closed);
  assert.equal(phone(code, ID(2)).last('error').reason, ERRORS.NO_ROOM);
});

test('the game screen can message one phone; phones cannot message each other', () => {
  const { relay, host, phone } = setup();
  const h = host();
  const { code } = h.last('room');
  const p1 = phone(code, ID(1));
  const p2 = phone(code, ID(2));

  relay.receive(h, { type: 'to-player', slot: 2, data: { buzz: [40] } });
  assert.deepEqual(p2.last('from-game'), { type: 'from-game', data: { buzz: [40] } });
  assert.equal(p1.all('from-game').length, 0);

  relay.receive(p1, { type: 'to-player', slot: 2, data: { buzz: [999] } }); // not allowed
  relay.receive(h, { type: 'to-player', slot: 2, data: 'nope' }); // not an object
  relay.receive(h, { type: 'to-player', slot: 3, data: { buzz: [1] } }); // nobody there
  assert.equal(p2.all('from-game').length, 1);
});
