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

## 17. A track is a list of points; everything else is computed (Phase 4)

**Chose:** 20 control points → our own centripetal Catmull-Rom spline → samples every 1 m, each with distance along the lap, direction, "right" and wall distances. Physics, race rules, the 3D track and the minimap all use the same samples.
**Instead of:** modelling the track in a 3D tool, or Three.js's `CatmullRomCurve3`.
**Why:** new tracks are a list of numbers; one source of truth means the road you see is exactly the road the physics and lap counting use; no Three.js in the logic, so it's all unit-tested.

## 18. Laps from continuous progress, checked by gates (Phase 4)

**Chose:** each racer accumulates "distance driven along the track" every step (the short way round the loop), with nearest-point search limited to ±12 m of last step's position, and jumps over 5 m ignored. Laps need every checkpoint in order.
**Instead of:** trigger boxes at checkpoints only.
**Why:** progress gives positions and wrong-way detection for free, can't be fooled by reversing over the line, and the local search can't jump across the infield. Trigger boxes alone can be skipped or double-counted.

## 19. Grass slows, walls stop (Phase 4)

**Chose:** off-road speed cap (11 m/s) plus tyre walls 16 m out, pulled in on the inside of tight corners so they never fold.
**Instead of:** walls right at the road edge.
**Why:** running wide should cost time, not stop you dead, which feels fair with tilt steering. Walls still keep everyone near the track and make shortcuts impossible.

## 20. Race time is physics time (Phase 4)

**Chose:** the race clock is the sum of fixed physics steps.
**Why:** lap times are exact and the same on every computer, even when frames stutter, and the rules can be tested by stepping time instead of waiting for it.

## 21. Drifting is a locked turn plus a visual slide (Phase 5)

**Chose:** while drifting, the physics kart keeps moving along its heading but turns at a fixed-direction rate (steering only tightens or widens it); the model swings 23° into the turn on its own group.
**Instead of:** real sideways velocity and tyre slip.
**Why:** predictable with tilt steering, easy to tune with two numbers, and it's how most kart racers do it. Decision 14 (velocity along the nose) still holds.

## 22. Mini-turbo charge only on the road (Phase 5)

**Chose:** blue at 0.9 s, orange at 2 s of drifting; the timer pauses on grass and in the air, and a wall ends the drift with no boost.
**Why:** rewards drifting through corners, not spinning in circles on the grass.

## 23. Boost raises the limit; extra speed fades (Phase 5)

**Chose:** a boost is seconds of higher top speed plus extra push, ignoring grass; afterwards extra speed bleeds off at 10 m/s².
**Instead of:** a speed multiplier, or snapping back to top speed.
**Why:** the fade makes boosts feel powerful and smooth, and one "seconds left" number is simple to grant from pads, mini-turbos and (Phase 6) items.

## 24. Track features are placed by position and snapped (Phase 5)

**Chose:** pads and ramps listed with a rough `near` point and a lane; the track computes their distance along the lap.
**Why:** adding or moving one is editing two numbers; no hand-computed distances that break when the track changes.

## 25. One generic game → phone message, batched and rate-limited (Phase 5)

**Chose:** `to-player { slot, data }` relayed as `from-game { data }`; the relay doesn't look inside. `feedback.js` sends at most one message per phone per frame and one buzz per 120 ms.
**Why:** the relay stays simple and future-proof (Phase 7's phone HUD rides the same message), and wall scrapes, which fire every physics step, don't flood the network or rattle a phone non-stop.

## 26. Tune live, save per browser, copy back to code (Phase 5)

**Chose:** a lil-gui panel over a mutable copy of `KART_PARAMS`, saved in localStorage, with "Copy as code".
**Why:** game feel is found by driving, not by reasoning. The defaults stay in code (and in tests); experiments stay local until you paste them in.
