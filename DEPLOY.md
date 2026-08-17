# Deploying KeyStone

KeyStone ships as **one Node process**: the server serves the built web app,
`/api`, and the `/ws` socket together. No database, no required API keys.

## Instant shareable URL (demo / pilot)

```bash
npm run share
```

Builds everything, starts ship mode, opens a **Cloudflare quick tunnel**
(no account needed) and prints a public `https://….trycloudflare.com` URL.
Share that link — it works from any browser while your machine stays on.
The URL changes each run. Requires `cloudflared` (`brew install cloudflared`).

## Run it locally (single machine / firehouse display)

```bash
npm run ship        # build + serve everything on :4010
```

Then open `http://localhost:4010` (or `http://<machine-ip>:4010` from any
device on the same network — tablets included).

## Permanent host (Render / Fly / any Node host)

- **Build**: `npm ci && npm run build`
- **Start**: `npm start` (listens on `WATCHTOWER_SERVER_PORT`, default 4010 —
  set it from the platform's `PORT` if required: `WATCHTOWER_SERVER_PORT=$PORT npm start`)
- **Node**: 20+
- WebSockets must be enabled (all common Node hosts support this).

## Environment (everything optional — the platform is keyless by default)

| Var | What it unlocks |
|---|---|
| `GOOGLE_MAPS_API_KEY` | Photorealistic 3D tiles + Street View panels |
| `CESIUM_ION_TOKEN` | World Terrain + OSM buildings (3D upgrade) |
| `SOCRATA_APP_TOKEN` | Higher NYC Open Data rate limits |
| `DEEPGRAM_API_KEY` | Streaming voice recognition w/ fireground vocabulary |
| `ANTHROPIC_API_KEY` | Voice assistant tier (unmatched phrases → closed-schema Claude) |
| `BROADCASTIFY_URL` | Live FDNY dispatch audio instead of the bundled recording |
| `WATCHTOWER_SERVER_PORT` | Port (default 4010) |

Docker sidecars (TAK server, MediaMTX video, faster-whisper) are **optional**
enrichments — everything degrades gracefully without them and the demo is
fully functional with none running.

## Notes for a public URL

- There is no authentication (pilot constraint) — treat the tunnel URL as a
  shared secret and rotate it by restarting `npm run share`.
- All incident data is simulated or public NYC Open Data; no PII exists in
  the system.
