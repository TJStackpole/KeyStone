# KEYSTONE

Browser-based 3D incident command dashboard (formerly WATCHTOWER) — a common operating picture demo for FDNY / NYC Emergency Management.

Operator types a NYC address → camera flies to a 3D view built from **real NYC Open Data** → an incident is created → units (real ATAK clients + simulated units, both speaking genuine Cursor-on-Target) appear as tracked markers → ICS perimeters, command posts, video panels, and a live comms/transcript panel complete the picture.

**Keyless by default.** The app runs with zero paid or registered API keys. Optional `.env` values unlock upgraded 3D tiles and live audio — see the table below.

## Quick start

```bash
docker compose up -d   # TAK server, MediaMTX + demo streams, whisper sidecar
npm install
npm run dev            # backend on :4000, dashboard on :5173
```

Open http://localhost:5173 and press **▶ DEMO: 100 GOLD ST**. That's the whole
demo: geocode → 3D fly-in → site intel → auto-perimeter → first-alarm dispatch
→ live comms. (First `docker compose up` downloads images and the Whisper
model; give it a few minutes once.)

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
| DOB violations / ECB / complaints / HPD | NYC Open Data (`3h2n-5cm9`, `6bgk-3dad`, `eabe-havv`, `wvxf-dwi5`) by BIN, with DOB BIS + ZoLa deep links | none |
| FDNY battalion / division boundaries | NYC Open Data (`xzng-ft6f`, `68m2-uzcb`), toggleable overlay | none |

Any Open Data failure degrades gracefully: logged, surfaced as a "layer unavailable" chip, never a crash.

## TAK server selection (Phase 3)

KEYSTONE's CoT spine runs through a **real open-source TAK server** in Docker
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

## Comms & legal posture (Phase 7)

The **FDNY channel** is real speech-to-text: a `faster-whisper` sidecar
transcribes the audio source and streams timestamped lines to the dashboard.
By default the source is `assets/audio/fdny-dispatch-demo.mp3` — a **synthetic,
TTS-generated FDNY-style dispatch recording** (no real radio traffic is bundled)
streamed as-if-live and labeled **AS-LIVE**. If `BROADCASTIFY_URL` is set to an
authenticated premium stream, the sidecar transcribes that live feed instead
(labeled **LIVE**), and falls back to the bundled recording automatically if
the stream is unreachable.

Two legal realities shape this design:

- **NYPD radio is encrypted** (migration beginning 2023) — real interception is
  neither technically possible nor legal, so the NYPD channel (and EMS/OEM) are
  **scripted simulations**, visibly watermarked SIMULATED.
- **Broadcastify's terms restrict rebroadcast/embedding** — the private demo
  uses the operator's own authenticated premium stream URL from `.env`, never a
  scraped or shared feed. A production deployment would ingest the department's
  own authorized radio-over-IP feed instead.

## Repo layout

```
web/      React + Vite + TypeScript + CesiumJS frontend
server/   Express + TypeScript + ws backend (incident state, CoT bridge)
data/     incident.json runtime persistence (gitignored)
docs/     ATAK connection guide (Phase 3+)
scripts/  operational scripts (CoT test publisher, etc.)
```

## The 5-minute demo (for a non-technical presenter)

Everything below is one click or one sentence. Practice once and it runs itself.

**Before the audience arrives:** run the two commands in Quick start, open
http://localhost:5173, and confirm the top bar shows **TAK LINK**.

1. **"This is a live common operating picture of New York City."**
   Click **▶ DEMO: 100 GOLD ST** (top bar). The camera flies to a 3D view of
   Lower Manhattan and locks onto 100 Gold Street, highlighted in amber.
   *Say: every building, hydrant, and firehouse you'll see is real city data,
   loading live from NYC Open Data.*

2. **"The system already knows the building."**
   Point at the **Site Intel** panel (right): floors, year built, land use from
   city records; the three nearest hydrants with distances; the three nearest
   firehouses — real companies, real addresses.

3. **"A perimeter is already suggested — and it's shared."**
   Point at the red **HOT ZONE** ring. *Say: this perimeter isn't a picture on
   this screen — it's broadcast over the same military-grade protocol (TAK)
   that's on responders' phones. Anyone running ATAK sees the same zone.*
   Optionally draw a warm zone: click **WARM**, click 3–4 corners, press Enter.

4. **"Watch the first alarm arrive."** (units are already rolling from the demo
   button) Point at the roster (left): *these are the actual companies that
   would get this box — Engine 6 from Beekman Street, the real firehouse 600
   feet away.* Watch statuses flip Enroute → On Scene → Operating.

5. **"Every unit is a real radio track."**
   Click a drone (cyan rotor) → its video panel opens (labeled SIMULATED).
   Click **BODYCAMS** (top right) → the 2×2 wall, tiles tied to units on the
   globe.

6. **"And the radio runs through it."**
   Point at the comms dock (bottom): the FDNY tab is machine-transcribed audio
   with unit numbers highlighted — *when dispatch says Engine 10, watch Engine
   10 flash on the map.* The NYPD/EMS/OEM tabs are simulations — NYPD radio is
   encrypted, and we don't pretend otherwise.

7. **"Command escalates with one touch."**
   Click **2ND ALARM** in the command strip — reinforcement companies appear
   and converge. Point at the elapsed clock and on-scene counts.

8. **The closer: click ⟲ REPLAY.**
   The whole incident re-runs at 4× with a scrub bar. *Say: every incident
   becomes its own after-action review. Nothing extra to write down.*

## Build status

| Phase | Scope | Status |
|---|---|---|
| 1 | Scaffold, keyless 3D globe, address → incident bootstrap | ✅ |
| 2 | Site intel (PLUTO, hydrants, firehouses) | ✅ |
| 3 | TAK spine (CoT in/out through real TAK server) | ✅ |
| 4 | First-alarm simulator + unit roster | ✅ |
| 5 | ICS perimeter + command post tools | ✅ |
| 6 | Video: drones + body-cam wall (MediaMTX) | ✅ |
| 7 | Comms fusion + live transcription | ✅ |
| 8 | Command header, demo scenario, replay, polish | ✅ |
