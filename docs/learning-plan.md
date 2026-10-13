# Learning plan

The full plan (what to learn in each phase, with resources) lives in the shared doc **Phone-Gyro Kart Racer — Learning Plan** on claude.ai. This page tracks progress against it.

**Shape of the game:** one shared screen (laptop, TV or tablet) shows the race; each player's phone is their own tilt-to-steer wheel; a small relay server connects them over Wi-Fi.

## Progress

| Phase | Topic | Est. | Status | Done when |
| --- | --- | --- | --- | --- |
| 0 | Setup and a page on your phone | 2–3 h | Built, check on phone | Phone shows the page over HTTPS; the laptop terminal logs each visit |
| 1 | Turn phone tilt into a steering value | 4–6 h | Built, check on phone | Level reads ~0, a comfortable tilt reaches ±1, no jitter when held still |
| 2 | Link phones to the game screen (WebSockets, rooms) | 5–7 h | Built, check on phones | Two phones join by QR; each tilt moves its own dial on the shared screen; reconnects after the phone locks |
| 3 | 3D world and a kart that drives (Three.js) | 8–12 h | Built, check on phones | Two players drive their own karts at once; keyboard still works |
| 4 | A real track with laps | 8–10 h | Not started | Finish a 3-lap race; corner cutting doesn't count; wrong-way warning |
| 5 | Kart feel: drift, boost, juice | 8–12 h | Not started | A friend drives 3 laps and asks to go again |
| 6 | AI opponents and items | 10–14 h | Not started | You win some races and lose others; items cause overtakes |
| 7 | Party mode: lobby, split screen, 4 players | 8–12 h | Not started | Four phones join in under a minute; one dropping out doesn't break the race |
| 8 | Polish and ship | 6–10 h | Not started | A stranger opens the link, scans, and plays without help |

"Built, check on phone" means the code is in and passes its tests, but the "done when" test needs a real phone in your hand. Mark it **Done** once it passes.

## Stretch goals

Online multiplayer across locations, a track editor, your own sensor fusion, or a Godot port.
