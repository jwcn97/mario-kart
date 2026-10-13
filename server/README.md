# Relay server

Pairs player phones with the shared game screen by room code and forwards their input. Protocol and design: [docs/phase-2-networking.md](../docs/phase-2-networking.md).

| File | Job |
| --- | --- |
| `relay.js` | Room and player rules, no networking (unit-tested with fake connections) |
| `attach.js` | Puts the relay on an HTTP(S) server with WebSockets, plus heartbeats |
| `index.js` | Standalone server for deployment: `npm run server` |

During development you don't run anything here yourself: `npm run dev` attaches the relay to the Vite dev server at `/ws`.
