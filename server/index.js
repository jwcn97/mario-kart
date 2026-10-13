/**
 * Standalone relay server (plain HTTP + WebSockets).
 *
 * You don't need this during development: `npm run dev` runs the relay inside
 * the Vite dev server. It's here for deployment (Phase 8), where a host such as
 * Fly.io or Render puts HTTPS in front of it.
 *
 *   PORT=8787 npm run server
 */
import { createServer } from 'node:http';
import { RELAY_PATH } from '../shared/protocol.js';
import { attachRelay } from './attach.js';

const port = Number(process.env.PORT) || 8787;

const server = createServer((req, res) => {
  // A tiny health check for hosting platforms.
  res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'text/plain' });
  res.end(req.url === '/health' ? 'ok' : 'not found');
});

attachRelay(server, { log: (line) => console.log(`[relay] ${line}`) });

server.listen(port, () => {
  console.log(`Relay listening on ws://localhost:${port}${RELAY_PATH}`);
});
