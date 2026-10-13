# Decisions

A short log of design choices. Newest at the bottom. Each entry: what we chose, what we didn't, and why.

## 1. Browser game, phones join by link (Phase 0)

**Chose:** web pages for both the game screen and the controller.
**Instead of:** a native app or a game engine.
**Why:** phones need no install, friends join by scanning a QR code, and every piece (sensors, networking, 3D) is a standard browser API worth learning.

## 2. Vite + plain JavaScript (Phase 0)

**Chose:** Vite as dev server and bundler, no UI framework.
**Instead of:** React or a game framework.
**Why:** fast reloads, multi-page support (controller, game, hub) out of the box, and nothing hides the browser APIs we're trying to learn.

## 3. Self-signed HTTPS for local dev (Phase 0)

**Chose:** `@vitejs/plugin-basic-ssl`, accepting a one-time certificate warning on each phone.
**Instead of:** mkcert (trusted certs, but you must install a root certificate on every phone) or a tunnel like ngrok (no warning, but traffic leaves your network and adds lag).
**Why:** zero setup. If the warning gets annoying, [phase-0-setup.md](phase-0-setup.md) explains switching to mkcert.

## 4. Steer from gravity in the screen plane (Phase 1)

**Chose:** turn beta and gamma into a gravity vector, rotate it into screen axes, and measure the angle of that vector around the screen's centre.
**Instead of:** reading gamma (or beta) directly as the steering angle.
**Why:** a raw Euler angle changes meaning depending on how far the player leans the phone back, and it jumps near vertical (gimbal lock). The gravity approach measures exactly "how much is the wheel turned", works whether the phone is upright or tilted back 60°, and ignores alpha (the compass), which drifts. Details in [phase-1-steering.md](phase-1-steering.md).

## 5. Calibrate on start, recenter on demand (Phase 1)

**Chose:** the first reading after Start is "straight ahead"; a Recenter button resets it; rotating the screen resets it too.
**Why:** everyone holds a phone differently. Calibration also absorbs any constant error in the screen-angle reading, so steering direction stays correct even on a browser that reports orientation oddly.

## 6. Phone lying flat means "let go of the wheel" (Phase 1)

**Chose:** when the phone is too flat to read (less than ~0.35 of gravity in the screen plane), steering eases back to 0.
**Instead of:** holding the last value.
**Why:** a player who puts the phone down shouldn't keep turning at full lock.
