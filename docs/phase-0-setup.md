# Phase 0 — Setup and a page on your phone

**Goal:** a page served from your computer opens on your phone over HTTPS, and the computer logs the visit.

Phones only give motion sensors to pages in a *secure context*, which in practice means `https://`. A plain `http://192.168.x.x` page can never read the gyro, so HTTPS comes first.

## Run it

```bash
npm install      # once
npm run dev      # starts the HTTPS dev server
```

The terminal prints:

1. Vite's own URLs (`Local` and `Network`).
2. The **game screen** address, for this computer and for other devices.
3. A `[visit]` line every time any device opens a page, with its IP and whether it's iOS, Android or desktop.

Open the game screen and scan its QR code with your phone's camera (from Phase 2; in Phase 0 the QR code was printed in the terminal). Your phone must be on the **same Wi-Fi** as the computer.

## The certificate warning (expected)

The dev server uses a self-signed certificate (see [decisions.md](decisions.md) #3), so the first visit shows a warning. It's your own computer, so it's safe to continue:

- **iPhone (Safari):** "This Connection Is Not Private" → **Show Details** → **visit this website** → **Visit Website**.
- **Android (Chrome):** "Your connection is not private" → **Advanced** → **Proceed to … (unsafe)**.

After that the address bar says "Not secure" instead of showing a padlock. The page is still `https://`, which is what the sensor APIs check, so motion access still works.

## How it works

`vite.config.js` does three things beyond Vite's defaults:

| Setting | Why |
| --- | --- |
| `basicSsl()` plugin | Generates the self-signed certificate so the server speaks HTTPS |
| `server.host: true` | Listens on your Wi-Fi address, not just `localhost`, so phones can reach it |
| `kartServer()` plugin | Logs page visits, prints the game screen address, and (from Phase 2) runs the relay at `/ws` |

It also lists the three pages (`index.html`, `controller/`, `game/`) so `npm run build` bundles all of them.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `ERR_SSL_PROTOCOL_ERROR` on `https://localhost:5173`, or `npm run dev` says "Port 5173 is already in use" | Something else holds port 5173, usually another project's dev server (plain http). Find it with `lsof -i :5173` and stop it, or run on another port with `npm run dev -- --port 5174` and open that port instead. |
| Phone can't load the page at all | Same Wi-Fi? Some office, school and guest networks block devices from talking to each other: try your phone's hotspot with the computer joined to it. |
| macOS asks whether `node` may accept incoming connections | Click **Allow**. If you clicked Deny: System Settings → Network → Firewall → Options. |
| Game screen warns it has no Wi-Fi address | The computer has no LAN address: connect it to Wi-Fi. |
| QR code points at the wrong address | You have several network adapters (VPN, Docker). Open the game screen using the `Network` URL Vite prints that matches your Wi-Fi; the QR code then uses that address. |
| Want no warning at all | Use [mkcert](https://github.com/FiloSottile/mkcert): `mkcert -install`, `mkcert <your-LAN-IP> localhost`, point `server.https` in `vite.config.js` at the generated key and cert, and install mkcert's root certificate on the phone (on iPhone also enable it under Settings → General → About → Certificate Trust Settings). |

## Done when

- [ ] `npm run dev` prints the game screen address.
- [ ] Your phone opens the controller page over `https://`.
- [ ] The terminal shows a `[visit] … (iOS)` or `(Android)` line for your phone.
