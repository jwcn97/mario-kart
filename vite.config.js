import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { attachRelay } from './server/attach.js';

const root = import.meta.dirname;

/** IPv4 addresses other devices on your Wi-Fi can reach this computer on. */
function lanAddresses() {
  return Object.values(networkInterfaces())
    .flat()
    .filter((net) => net && net.family === 'IPv4' && !net.internal)
    .map((net) => net.address);
}

function describeDevice(userAgent = '') {
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'iOS';
  if (/Android/.test(userAgent)) return 'Android';
  return 'desktop';
}

/** Shared by `vite` (dev) and `vite preview` (production build). */
function addKartMiddleware(server) {
  server.middlewares.use((req, res, next) => {
    // The game screen asks this when it's opened on localhost, so the QR code it
    // shows points phones at an address they can actually reach.
    if (req.url === '/__kart/lan') {
      const port = req.socket.localPort;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ origins: lanAddresses().map((ip) => `https://${ip}:${port}`) }));
      return;
    }

    // Log page visits, so you can see each phone reach this computer.
    const wantsPage = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
    if (wantsPage) {
      const ip = (req.socket.remoteAddress || '?').replace('::ffff:', '');
      const time = new Date().toLocaleTimeString();
      console.log(`[visit] ${time}  ${req.url}  from ${ip} (${describeDevice(req.headers['user-agent'])})`);
    }
    next();
  });

  if (server.httpServer) {
    // The relay (rooms + WebSockets) lives on the same HTTPS server at /ws.
    attachRelay(server.httpServer, { log: (line) => console.log(`[relay] ${line}`) });

    server.httpServer.once('listening', () => {
      const address = server.httpServer.address();
      const port = typeof address === 'object' && address ? address.port : 5173;
      const [ip] = lanAddresses();
      setTimeout(() => {
        console.log('\n  Game screen (laptop / TV):');
        console.log(`    https://localhost:${port}/game/`);
        if (ip) console.log(`    https://${ip}:${port}/game/   (from another device)`);
        else console.log('    No Wi-Fi address found: phones won’t be able to connect.');
        console.log('  Phones join by scanning the QR code on the game screen.\n');
      }, 150);
    });
  }
}

function kartServer() {
  return {
    name: 'kart-server',
    configureServer: addKartMiddleware,
    configurePreviewServer: addKartMiddleware,
  };
}

export default defineConfig({
  plugins: [basicSsl(), kartServer()],
  server: {
    host: true, // listen on the LAN, not just localhost, so phones can connect
    port: 5173,
    // If 5173 is taken (often another project's dev server, speaking plain http),
    // stop with an error instead of quietly moving to 5174: opening the usual
    // https://localhost:5173 would then reach that other server and fail with
    // ERR_SSL_PROTOCOL_ERROR.
    strictPort: true,
  },
  preview: {
    host: true,
  },
  build: {
    rolldownOptions: {
      input: {
        hub: resolve(root, 'index.html'),
        controller: resolve(root, 'controller/index.html'),
        game: resolve(root, 'game/index.html'),
      },
    },
  },
});
