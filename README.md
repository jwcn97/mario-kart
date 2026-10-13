# Kart Racer

A browser kart racer for a room full of friends: the race runs on one shared screen (laptop, TV or tablet), and each player's phone is their own tilt-to-steer wheel. No app install; phones join by scanning a QR code.

Built phase by phase as a learning project. Current stage: **Phase 1** (the phone turns tilt into a steering value).

## Quick start

Needs Node.js 20.19+ or 22.12+.

```bash
npm install
npm run dev
```

Scan the QR code printed in the terminal with your phone (same Wi-Fi), accept the one-time certificate warning, tap **Tap to start**, and hold the phone sideways like a steering wheel.

| Command | What it does |
| --- | --- |
| `npm run dev` | HTTPS dev server on your network, with a QR code for phones |
| `npm test` | Unit tests for the steering math |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |

## Docs

See [docs/](docs/README.md): the learning plan and progress, architecture, design decisions, and one write-up per phase.
