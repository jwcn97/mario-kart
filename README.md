# Kart Racer

A browser kart racer for a room full of friends: the race runs on one shared screen (laptop, TV or tablet), and each player's phone is their own tilt-to-steer wheel. No app install; phones join by scanning a QR code.

Built phase by phase as a learning project. Current stage: **Phase 2**. Phones join the game screen by QR code and their steering shows up live; racing starts in Phase 3.

## Quick start

Needs Node.js 20.19+ or 22.12+.

```bash
npm install
npm run dev
```

Open **https://localhost:5173/game/** on your laptop (or the address the terminal prints, on a TV or tablet). Scan its QR code with each phone (same Wi-Fi), accept the one-time certificate warning, tap **Tap to start**, and hold the phone sideways like a steering wheel.

| Command | What it does |
| --- | --- |
| `npm run dev` | HTTPS dev server on your network, with the relay at `/ws` |
| `npm test` | Steering, relay and network tests |
| `npm run server` | The relay on its own (for deployment later; not needed for dev) |
| `npm run build` | Production build into `dist/` |
| `npm run preview` | Serve the production build |

## Docs

See [docs/](docs/README.md): the learning plan and progress, architecture, design decisions, and one write-up per phase.
