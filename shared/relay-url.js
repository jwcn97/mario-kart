import { RELAY_PATH } from './protocol.js';

/**
 * Where the relay server is. In development it's on the same server as the
 * page, at /ws. A deployed game can point elsewhere by setting
 * VITE_RELAY_URL=wss://your-relay.example.com/ws at build time.
 */
export function relayUrl() {
  const configured = import.meta.env.VITE_RELAY_URL;
  if (configured) return configured;
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${RELAY_PATH}`;
}
