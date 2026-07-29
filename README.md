# WATCHTOWER

Browser-based 3D incident command dashboard — a common operating picture demo for FDNY / NYC Emergency Management.

Operator types a NYC address → camera flies to a 3D view built from **real NYC Open Data** → an incident is created → units (real ATAK clients + simulated units, both speaking genuine Cursor-on-Target) appear as tracked markers → ICS perimeters, command posts, video panels, and a live comms/transcript panel complete the picture.

**Keyless by default.** The app runs with zero paid or registered API keys. Optional `.env` values unlock upgraded 3D tiles and live audio — see the table below.

## Quick start

```bash
npm install
npm run dev        # server on :4000, web on :5173
```

Open http://localhost:5173 and type `100 Gold Street`.

Docker (`docker compose up`) is required starting at Phase 3 (TAK server) — not needed for Phases 1–2.

## `.env` upgrades (all optional)

| Variable | Absent (default) | Present |
|---|---|---|
| `CESIUM_ION_TOKEN` | OSM imagery + ellipsoid terrain + self-extruded NYC footprints | Cesium World Terrain + OSM Buildings |
| `GOOGLE_MAPS_API_KEY` | — | Google Photorealistic 3D Tiles (wins over ion) |
| `BROADCASTIFY_URL` | Bundled FDNY-style dispatch recording | Live authenticated Broadcastify stream |

Copy `.env.example` to `.env` and fill in what you have. No code changes needed to swap providers.

## Real data sources

| Data | Source | Auth |
|---|---|---|
| Geocoding / autocomplete | NYC GeoSearch API (`geosearch.planninglabs.nyc/v2`) | none |
| Building footprints + heights | NYC Open Data Building Footprints (SODA `5zhs-2jue`) | none |
| Parcel attributes | NYC Open Data PLUTO | none |
| Hydrants | NYC Open Data Fire Hydrants | none |
| Firehouses | NYC Open Data FDNY Firehouse Listing | none |

Any Open Data failure degrades gracefully: logged, surfaced as a "layer unavailable" chip, never a crash.

## TAK server selection (Phase 3)

WATCHTOWER's CoT spine runs through a **real open-source TAK server** in Docker
([taky](https://github.com/tkuester/taky) v0.10) — the backend is a plain-TCP
CoT client on port 8087, exactly like an ATAK phone. The CoT client is
server-agnostic: `TAK_HOST` / `TAK_PORT` in `.env` point it anywhere, including
a TAK Product Center TAK Server, with zero code change.

CLAUDE.md prefers OpenTAKServer with FreeTAKServer as fallback. Both were
deployed and tested empirically on 2026-07-29, and both shipped broken:

| Server | Failure |
|---|---|
| OpenTAKServer `ghcr.io/brian7704/opentakserver:latest` | plain-TCP EUD path crashes per connection (`from opentakserver.eud_handler import EudHandler` binds the module, not the class); after patching, CoT router also crashes on pika's blocking API (`.is_closing` doesn't exist) and fan-out still never reaches subscribed EUDs |
| OpenTAKServer official per-service images (`ots_eud_handler:master`, `ots_cot_parser:master`, full RabbitMQ MQTT/auth-http wiring mirrored from OpenTAKServer-Docker) | EUD handler's per-client AMQP connection aborts mid-handshake (pika `AMQPConnectionWorkflowAborted` assertion) — no per-EUD queue is ever bound, so no client receives fan-out |
| FreeTAKServer 2.2.1 (PyPI; Docker Hub tags no longer exist) | DigitalPy component registry fails en masse (a shipped file has a tabs/spaces `SyntaxError`); startup dies on an OpenTelemetry `BatchSpanProcessor` AttributeError |
| FreeTAKServer 1.9.9.6 (classic) | eventlet incompatible with Python ≥ 3.10 (`socket.timeout` immutability); pinned lxml 4.6.5 predates Python 3.11 |

taky passed the same gate the others failed — two independent TCP clients,
one publishes a CoT event, the other receives it verbatim — before adoption.
The acceptance probe is reproducible:

```bash
docker compose up -d
npm run publish-test-unit   # publishes CoT for "E-99" — appears on the globe in <2 s
```

How to connect a real ATAK/iTAK phone: [docs/connect-atak.md](docs/connect-atak.md).

## Repo layout

```
web/      React + Vite + TypeScript + CesiumJS frontend
server/   Express + TypeScript + ws backend (incident state, CoT bridge)
data/     incident.json runtime persistence (gitignored)
docs/     ATAK connection guide (Phase 3+)
scripts/  operational scripts (CoT test publisher, etc.)
```

## Build status

| Phase | Scope | Status |
|---|---|---|
| 1 | Scaffold, keyless 3D globe, address → incident bootstrap | ✅ |
| 2 | Site intel (PLUTO, hydrants, firehouses) | ✅ |
| 3 | TAK spine (CoT in/out through real TAK server) | ✅ |
| 4 | First-alarm simulator + unit roster | ✅ |
| 5 | ICS perimeter + command post tools | — |
| 6 | Video: drones + body-cam wall (MediaMTX) | — |
| 7 | Comms fusion + live transcription | — |
| 8 | Command header, demo scenario, replay, polish | — |
