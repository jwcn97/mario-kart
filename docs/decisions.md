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

## 7. Plain WebSockets with `ws` (Phase 2)

**Chose:** the `ws` library on the server, the browser's built-in `WebSocket` on the clients, our own small reconnect wrapper (`shared/net.js`).
**Instead of:** Socket.IO (adds its own protocol and reconnect logic) or WebRTC data channels (lower latency in theory, but needs a signalling step and is much harder to debug).
**Why:** you see and own every piece: how reconnecting works, how a dead link is noticed, what's on the wire. On home Wi-Fi a WebSocket already lands well under the 50 ms target. WebRTC stays a stretch goal.

## 8. Relay lives inside the dev server (Phase 2)

**Chose:** attach the relay to Vite's HTTPS server at `/ws`.
**Instead of:** a second server on another port.
**Why:** phones already accepted that address's certificate when loading the page. A second port would need a second certificate approval, and the pages would need to know another address. `server/index.js` still runs the relay on its own for deployment.

## 9. Fixed 60 Hz input stream (Phase 2)

**Chose:** phones send `{ steer, seq }` on a 60 Hz timer.
**Instead of:** sending on every sensor event, or only when the value changes.
**Why:** sensor rates vary by phone, and "only on change" makes a silent phone indistinguishable from a dead one. A steady stream is predictable for physics and doubles as a liveness signal.

## 10. Who's who: player id per tab, room token per game screen (Phase 2)

**Chose:** each controller tab makes a random `playerId` (sessionStorage); each game screen keeps its room `code` + secret `token` (sessionStorage). Dropped players and rooms are held for 60 s.
**Why:** reconnects and reloads land back in the same slot or room without accounts or logins. Per tab, not per browser, so two tabs on one laptop can be two players while testing. The token stops another screen from taking over a room just by knowing its code.

## 11. Recover from server restarts (Phase 2)

**Chose:** a game screen that reconnects to a server with no memory of its room recreates it under the same code; phones retry "no such room" every 2 s and ask for their previous slot.
**Why:** the dev server restarts whenever its config changes, and a deployed server will restart on every update. Players shouldn't have to rescan, and shouldn't swap colours mid-session.

## 12. Three.js, own arcade physics, no physics engine (Phase 3)

**Chose:** Three.js for drawing only; kart physics written by hand in `game/physics.js`.
**Instead of:** a physics engine (Rapier, cannon-es) or a full game engine.
**Why:** kart racers want arcade handling (instant grip, tunable understeer), not realistic simulation. A physics engine would need fighting to feel arcade-y. Hand-written physics is ~200 lines, has no Three.js dependency, and is unit-tested with plain numbers.

## 13. Fixed 120 Hz physics with interpolated rendering (Phase 3)

**Chose:** an accumulator that runs physics in equal 1/120 s steps, drawing karts between the last two states.
**Instead of:** stepping by each frame's duration.
**Why:** identical handling on 60 Hz laptops and 144 Hz monitors, and physics that's deterministic enough to test. 120 rather than 60 so fast karts don't tunnel through thin obstacles.

## 14. Velocity always along the nose (Phase 3)

**Chose:** one scalar speed along the kart's heading; no sideways velocity.
**Why:** the simplest model that feels right for a first drive, and easy to reason about. Sliding (drifting) is a deliberate Phase 5 feature, layered on top.

## 15. Keyboard overrides a phone only while keys are held (Phase 3)

**Chose:** arrows = P1, W A S D = P2; holding any of a slot's keys takes over that slot, releasing hands back to the phone. Phone input older than 500 ms counts as released.
**Why:** test without phones, and take over a kart mid-drive without any mode switch. The staleness rule means a locked or lost phone never leaves a kart driving off with the gas held.

## 16. One shared camera that frames everyone (Phase 3)

**Chose:** auto camera: chase cam for one kart, a "group" camera over the middle of the pack for several.
**Instead of:** split screen right away.
**Why:** the plan saves split screen for Phase 7. A group camera is enough to see everyone while the driving itself gets built.
