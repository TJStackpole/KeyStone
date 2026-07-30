# Connecting a real ATAK / iTAK device to KEYSTONE

This is the credibility moment: a phone running ATAK on the same Wi-Fi appears
on the KEYSTONE globe as a live tracked unit, via the same TAK server and the
same Cursor-on-Target protocol the simulator uses. The dashboard cannot tell
them apart — that's the point.

## Prerequisites

- KEYSTONE stack running on your Mac/PC: `docker compose up -d` + `npm run dev`
- Phone with **ATAK-CIV** (Android, Play Store) or **iTAK** (iOS, App Store)
- Phone and computer on the **same LAN / Wi-Fi**

## 1. Find your computer's LAN IP

macOS:

```bash
ipconfig getifaddr en0
```

(Windows: `ipconfig` → IPv4 Address. Linux: `hostname -I`.)

Example result: `192.168.1.42` — used below as `<LAN-IP>`.

## 2. Add the server in ATAK (Android)

1. ≡ menu → **Settings** → **Network Connections** → **Network Connections**
2. Tap **Add** (+) → **Manually Enter**
3. Fill in:
   - **Address:** `<LAN-IP>`
   - Tap **Advanced Options**
   - **Server Port:** `8087`
   - **Server Protocol:** `TCP` (plain — demo network only, see note below)
4. Save. The connection indicator turns green when the TAK link is up.

## 3. Add the server in iTAK (iOS)

1. **Settings** (gear) → **Network** → **Servers** → **+**
2. Choose **Manual entry**:
   - **Host:** `<LAN-IP>`
   - **Port:** `8087`
   - **Protocol:** `TCP`
3. Save and enable the server.

## 4. See it on KEYSTONE

Walk around — your callsign (set in ATAK under Settings → Callsign) appears on
the globe as a tracked marker within a couple of seconds of each position
report, and joins the roster under its agency group (unrecognized callsigns
file under **TAK**). Use an FDNY-style callsign (e.g. `E-99`, `BC-01`) and the
marker adopts that unit type's symbology automatically.

The reverse works too: ICS perimeters and command posts drawn in KEYSTONE
(Phase 5) are published as CoT into the TAK server, so they render inside ATAK.

## Security note (demo posture)

Plain-TCP CoT on 8087 is **unencrypted and unauthenticated** — appropriate only
for a private demo LAN. A production deployment would use the TAK server's TLS
port (8089) with client certificates enrolled per device, and never expose
either port beyond the incident network.

## Troubleshooting

- **Gray/red connection dot in ATAK:** phone and computer not on the same
  network, or the Mac firewall is blocking inbound 8087 (System Settings →
  Network → Firewall). Docker publishes 8087 on all interfaces by default.
- **Connected but no marker on KEYSTONE:** confirm the backend shows
  `[tak] connected` in `npm run dev` output and the top bar shows **TAK LINK**;
  check `docker compose logs takserver` for the phone's connection.
- **Marker appears then vanishes:** ATAK's default reporting rate is fine, but
  if you force-closed the app, the last event's stale time passes and
  KEYSTONE sweeps the unit (by design).
