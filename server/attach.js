/**
 * Puts the Relay on a real HTTP(S) server using WebSockets (the `ws` library).
 *
 * In development it's attached to Vite's own HTTPS server (see vite.config.js),
 * so phones use the same address and certificate as the pages. server/index.js
 * runs it standalone for deployment later.
 */
import { WebSocketServer } from 'ws';
import { RELAY_PATH } from '../shared/protocol.js';
import { Relay } from './relay.js';

const HEARTBEAT_MS = 5_000;

export function attachRelay(httpServer, { path = RELAY_PATH, log = console.log, relay = new Relay({ log }) } = {}) {
  // noServer: we route upgrades ourselves, so Vite's own hot-reload socket keeps working.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  const onUpgrade = (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== path) return; // not ours (e.g. Vite's HMR socket)
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  };
  httpServer.on('upgrade', onUpgrade);

  wss.on('connection', (ws) => {
    const conn = {
      send(msg) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
      },
      close(code, reason) {
        ws.close(code, reason);
      },
    };
    relay.connect(conn);

    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return; // not JSON: ignore
      }
      relay.receive(conn, msg);
    });

    ws.on('close', () => relay.disconnect(conn));
    ws.on('error', () => {}); // a 'close' always follows
  });

  // Heartbeat: a phone that locks or walks out of Wi-Fi often vanishes without
  // closing its socket. Protocol-level pings find those within ~10 s.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
    relay.sweep();
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const close = () => {
    clearInterval(heartbeat);
    httpServer.off('upgrade', onUpgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
  httpServer.once('close', close);

  return { relay, wss, close };
}
