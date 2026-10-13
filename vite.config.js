import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import qrcode from 'qrcode-terminal';

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

/**
 * Dev-only helpers:
 *  - logs every page visit, so you can see your phone reach the laptop
 *  - prints a QR code for the controller page once the server is up
 */
function kartDevHelpers() {
  return {
    name: 'kart-dev-helpers',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const wantsPage = req.method === 'GET' && (req.headers.accept || '').includes('text/html');
        if (wantsPage) {
          const ip = (req.socket.remoteAddress || '?').replace('::ffff:', '');
          const time = new Date().toLocaleTimeString();
          console.log(`[visit] ${time}  ${req.url}  from ${ip} (${describeDevice(req.headers['user-agent'])})`);
        }
        next();
      });

      server.httpServer?.once('listening', () => {
        const address = server.httpServer.address();
        const port = typeof address === 'object' && address ? address.port : server.config.server.port;
        const [ip] = lanAddresses();
        if (!ip) {
          console.log('\n  No Wi-Fi/LAN address found. Connect this computer to the same network as your phone.\n');
          return;
        }
        const url = `https://${ip}:${port}/controller/`;
        // Wait a beat so this prints after Vite's own startup banner.
        setTimeout(() => {
          console.log(`\n  Phone controller: ${url}`);
          console.log('  Scan this with your phone camera (same Wi-Fi as this computer):\n');
          qrcode.generate(url, { small: true });
        }, 150);
      });
    },
  };
}

export default defineConfig({
  plugins: [basicSsl(), kartDevHelpers()],
  server: {
    host: true, // listen on the LAN, not just localhost, so phones can connect
    port: 5173,
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
