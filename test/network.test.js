/**
 * End-to-end over real WebSockets: relay server + the same connection code the
 * browser pages use (shared/net.js), with the `ws` library standing in for the
 * browser's WebSocket.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { attachRelay } from '../server/attach.js';
import { createConnection } from '../shared/net.js';

async function startServer(port = 0) {
  const server = createServer();
  const relayHandle = attachRelay(server, { log: () => {} });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  const stop = () =>
    new Promise((resolve) => {
      relayHandle.close();
      server.close(resolve);
      server.closeAllConnections?.();
    });
  return { server, url, port: server.address().port, relay: relayHandle.relay, wss: relayHandle.wss, stop };
}

async function waitFor(check, what, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A game screen client that remembers its room, like game/main.js does. */
function hostClient(url) {
  const client = { saved: null, players: new Map(), inputs: [] };
  client.conn = createConnection({
    url,
    WebSocketImpl: WebSocket,
    pingEveryMs: 50,
    hello: () => ({ type: 'host', code: client.saved?.code, token: client.saved?.token }),
    onMessage: (msg) => {
      if (msg.type === 'room') client.saved = { code: msg.code, token: msg.token };
      if (msg.type === 'player') client.players.set(msg.slot, msg);
      if (msg.type === 'input') client.inputs.push(msg);
    },
  });
  return client;
}

/** A phone client, like controller/main.js. */
function phoneClient(url, code, playerId) {
  const client = { joined: null, hostConnected: null, errors: [] };
  client.conn = createConnection({
    url,
    WebSocketImpl: WebSocket,
    pingEveryMs: 50,
    hello: () => ({ type: 'join', code, playerId }),
    onMessage: (msg) => {
      if (msg.type === 'joined') client.joined = msg;
      if (msg.type === 'host-status') client.hostConnected = msg.connected;
      if (msg.type === 'error') client.errors.push(msg.reason);
      // The room may not exist *yet* (server just restarted): try again shortly.
      if (msg.type === 'error' && msg.reason === 'no-room') client.conn.retry(100);
    },
  });
  return client;
}

test('two phones join a game screen and their steering arrives tagged by slot', async (t) => {
  const srv = await startServer();
  const host = hostClient(srv.url);
  t.after(() => host.conn.stop());
  t.after(srv.stop);

  const { code } = await waitFor(() => host.saved, 'room code');
  const a = phoneClient(srv.url, code, 'phone-aaaa');
  const b = phoneClient(srv.url, code, 'phone-bbbb');
  t.after(() => a.conn.stop());
  t.after(() => b.conn.stop());

  await waitFor(() => a.joined && b.joined, 'both phones to join');
  assert.deepEqual([a.joined.slot, b.joined.slot].sort(), [1, 2]);
  assert.equal(a.hostConnected, true);

  a.conn.send({ type: 'input', steer: -0.5, seq: 1 });
  b.conn.send({ type: 'input', steer: 0.25, seq: 1 });
  await waitFor(() => host.inputs.length >= 2, 'inputs at the host');
  const bySlot = Object.fromEntries(host.inputs.map((m) => [m.slot, m.steer]));
  assert.equal(bySlot[a.joined.slot], -0.5);
  assert.equal(bySlot[b.joined.slot], 0.25);

  await waitFor(() => a.conn.rtt !== null && host.conn.rtt !== null, 'round-trip times');
});

test('a phone whose connection dies reconnects into the same slot', async (t) => {
  const srv = await startServer();
  const host = hostClient(srv.url);
  t.after(() => host.conn.stop());
  t.after(srv.stop);

  const { code } = await waitFor(() => host.saved, 'room code');
  const phone = phoneClient(srv.url, code, 'phone-cccc');
  t.after(() => phone.conn.stop());
  await waitFor(() => phone.joined, 'join');
  const slot = phone.joined.slot;

  // Kill every socket from the server side, like Wi-Fi dropping.
  for (const ws of srv.wss.clients) ws.terminate();
  await waitFor(() => host.players.get(slot)?.connected === false || phone.conn.status === 'reconnecting', 'the drop');
  phone.joined = null;

  await waitFor(() => phone.joined && host.players.get(slot)?.connected, 'reconnect');
  assert.equal(phone.joined.slot, slot);
});

test('after a server restart the game keeps its room code and the phone rejoins', async (t) => {
  const first = await startServer();
  const port = first.port;
  const host = hostClient(first.url);
  t.after(() => host.conn.stop());

  const { code } = await waitFor(() => host.saved, 'room code');
  const phone = phoneClient(first.url, code, 'phone-dddd');
  t.after(() => phone.conn.stop());
  await waitFor(() => phone.joined, 'join');

  await first.stop();
  phone.joined = null;
  const second = await startServer(port); // same address, empty memory
  t.after(second.stop);

  await waitFor(() => phone.joined, 'rejoin after restart', 8000);
  assert.equal(host.saved.code, code);
  assert.equal(phone.joined.code, code);
});

test('a socket that stops answering pings is replaced', async (t) => {
  // A server that accepts connections but never replies: a half-dead link.
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let connections = 0;
  wss.on('connection', () => connections++);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => {
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    server.close(r);
  }));

  const conn = createConnection({
    url: `ws://127.0.0.1:${server.address().port}`,
    WebSocketImpl: WebSocket,
    pingEveryMs: 30,
    staleAfterMs: 120,
  });
  t.after(() => conn.stop());

  await waitFor(() => connections >= 2, 'a fresh connection after the stale one');
});

test('stop() means no more reconnects', async (t) => {
  const srv = await startServer();
  t.after(srv.stop);
  const statuses = [];
  const conn = createConnection({ url: srv.url, WebSocketImpl: WebSocket, onStatus: (s) => statuses.push(s) });
  await waitFor(() => conn.connected, 'connect');
  conn.stop();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(conn.status, 'stopped');
  assert.equal(srv.wss.clients.size, 0);
  assert.deepEqual(statuses, ['connecting', 'connected', 'stopped']);
});
