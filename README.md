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
   Click **▶ DEMO** (top bar). The camera flies to a 3D view of Lower
   Manhattan and locks onto 100 Gold Street in a translucent amber box.
   *Say: every building, hydrant, firehouse, and street name you'll see is
   real city data, loading live from NYC Open Data.*

2. **"The system already knows the building."**
   Point at **Site Intel** (right): floors, year built, land use, DOB
   violations, Certificates of Occupancy — plus the three nearest hydrants
   and firehouses. Tap ANY other building: its record pops up too, and its
   address lands in the search bar.

3. **"Watch the first alarm converge — live."**
   Point at the colored tails behind moving units: red FDNY companies
   rolling from their real firehouses, blue NYPD taking the perimeter.
   Roster statuses flip Enroute → On Scene → Operating; crews dismount and
   climb — the FLOORS tab shows who's on which floor, BIO shows who needs
   rotation.

4. **"The chief works the map directly."**
   Draw a perimeter (**PERIM**: click corners, Enter). Drop truck-scale
   staging pads (**STGE**: pick a responding unit, click; drag to move,
   [ ] to rotate). *Everything publishes over TAK — anyone on ATAK sees
   the same picture, and TAK Chat (click TAK LINK) reaches their phones.*

5. **"Isolate the fire building."**
   With ACTIVE INCIDENT on, click **ISOLATE** — the entire city strips away
   and the real photorealistic fire building lifts above the map at maximum
   image quality. Click **STV** for Google Street View of the front door.
   Click the compass (bottom-left) any time you're lost — it re-norths.

6. **"And the radio runs through it."**
   The comms dock (bottom): the FDNY tab is machine-transcribed audio with
   unit numbers highlighted — *when dispatch says Engine 10, watch Engine 10
   flash on the map.* NYPD/EMS/OEM tabs are simulations — NYPD radio is
   encrypted, and we don't pretend otherwise.

7. **"Command escalates with one touch."**
   Click **2ND ALARM** — reinforcements converge with tails. Toggle
   **TRAFFIC** in Site Intel for live DOT congestion on the approach routes
   (dark red = heavy, red, yellow; free-flowing roads draw nothing).

8. **The closer — the drill.** Click **▶ DRILL**: a scripted five-chapter
   multi-agency exercise at the Port Authority Bus Terminal plays itself —
   PAPD first-due, MCI, Unified Command, a mayday with live PAR, and an
   auto-generated after-action report. Jump straight to **Mayday + PAR**
   with the chapter buttons. Toggle **NYCEM** for the Watch Command
   coordination view. Everything is labeled DRILL — SIMULATED INCIDENT.
   (⟲ REPLAY still re-runs any live incident as its own after-action.)

**To reset anything:** ✕ END on the incident card (two clicks) clears every
drill, demo, and incident on all screens.

## Build status

**Latest — FDNY command features:** the OPS CLOCK now runs the fireground's
time discipline server-side (10-minute duration marks, PAR cycle with a
countdown chip — interval default 20 min, VALIDATE—SME); the DECISION LOG
(MANUAL → LOG) is a one-tap ICS-214: alarm benchmarks escalate and log on one
path, notes and benchmarks land with server timestamps, and the whole log
prints as an ICS-214 activity sheet; the RESOURCE LEDGER (MANUAL → RESOURCES)
buckets every rig by live status, previews the next alarm with the same logic
that would dispatch it, and flags EMPTY QUARTERS with simulated relocation
suggestions (labeled SIMULATED, VALIDATE—SME).

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

## Since v0.1.0 (KeyStone)

Rebranded WATCHTOWER → **KEYSTONE**. Major additions, all keyless-safe and
TAK-published where applicable:

- **Scenario engine + PABT drill** — scripted multi-agency incidents played
  through the live pipelines (`assets/scenarios/*.json`, ▶ DRILL); chapter
  jumps, 1×/4×/10×, NYCEM Watch Command view, mayday alerting, auto
  after-action report (print → PDF).
- **Chief tools** — staging pads with unit picker/drag/rotate, editable
  PERIM outlines, collapse zones, measure; exposure designations.
- **Views** — ISOLATE (clip + lift the real fire building, max detail),
  top-down satellite toggle, GND ground view with a 0–50 ft height scale,
  Google Street View panel (STV), compass re-north.
- **Data layers** — live DOT traffic (color-coded congestion), street-name
  captions along their streets, DOB violations + Certificates of Occupancy,
  tap-a-building record lookup, FDNY battalion/division boundaries.
- **Tracking policy** — ⦿ GPS master switch: vehicles for all agencies,
  member dots only for firefighters inside the building; live response
  trails for converging apparatus.
- **Comms** — TAK GeoChat to every EUD on the server (TAK LINK chip),
  voice input on the address search, multi-channel drill radio with a
  merged command view.
- **Ops hygiene** — ✕ END clears drill/demo/incident everywhere; a
  46-agent adversarial review swept the platform and all 40 confirmed
  findings were fixed.
