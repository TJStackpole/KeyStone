# KEYSTONE — Project Context (CLAUDE.md)

Place this file at the repo root. Claude Code reads it automatically every session.

## What this is

KEYSTONE (formerly WATCHTOWER) is a browser-based 3D incident command dashboard — a common operating picture demo for FDNY / NYC Emergency Management. Core flow: operator types a NYC address → camera flies to a 3D view of the site built from **real NYC Open Data** → an incident is created → units (real ATAK clients + simulated units, both speaking genuine Cursor-on-Target) appear as tracked markers → operator draws ICS perimeters and command posts → drone/body-cam video panels and a comms/transcript panel complete the picture.

This is a pilot demo for real stakeholders, not a toy. Real data and real protocols everywhere possible; simulation only where reality is inaccessible (encrypted NYPD radio, on-scene video), and every simulated element is visibly labeled SIMULATED.

## Hard constraints — never violate

1. **Keyless by default.** The app must run with ZERO paid or registered API keys. No Google Maps key, no Cesium ion token, no Broadcastify account. Upgrade paths behind `.env` flags are welcome but must never be required. If a `.env` key is absent, silently use the keyless path.
2. **Keyless 3D strategy:** CesiumJS with `OpenStreetMapImageryProvider` basemap + `EllipsoidTerrainProvider` (NYC is flat enough). Buildings are **extruded ourselves**: fetch NYC Open Data Building Footprints (heightroof attribute) near the incident and render as extruded Cesium polygon primitives. If `CESIUM_ION_TOKEN` exists in `.env`, upgrade to World Terrain + OSM Buildings; if `GOOGLE_MAPS_API_KEY` exists, upgrade to Photorealistic 3D Tiles. Provider selection is one function, no code edits to swap.
3. **Audio:** transcribe a bundled recorded FDNY-dispatch-style audio file (`assets/audio/fdny-dispatch-demo.mp3`, generate a placeholder with TTS if needed) streamed as if live. If `BROADCASTIFY_URL` exists in `.env`, use it instead. Never require it.
4. **Real protocols:** all unit positions flow as genuine CoT XML through a real open-source TAK server (OpenTAKServer preferred, FreeTAKServer fallback) in Docker. The dashboard must not be able to tell simulated CoT from a real ATAK phone's CoT.
5. **No PII, no auth, no real personnel data, single incident at a time, desktop layout only.**
6. Every phase leaves the app runnable via `docker compose up` + `npm run dev`. Never break the previous phase's acceptance criteria.

## Fixed tech stack

- Frontend: React + Vite + TypeScript, CesiumJS (`cesium` npm + `vite-plugin-cesium`)
- Backend: Node.js + Express + TypeScript, `ws` WebSocket push to browser
- TAK: OpenTAKServer in Docker; backend is a CoT TCP client (8087) + CoT publisher
- Transcription: `faster-whisper` (base model) in a small Python sidecar container, chunked output over WebSocket
- Video: MediaMTX in Docker (RTSP in → WebRTC/HLS out); demo sources are looped local MP4s
- State: in-memory + `incident.json` file persistence. No database.

## Real data sources

| Data | Source | Auth |
|---|---|---|
| Geocoding/autocomplete | NYC GeoSearch API `geosearch.planninglabs.nyc/v2/search` | none |
| Building footprints + heights | NYC Open Data Building Footprints (Socrata SODA) | none |
| Parcel attributes (floors, use, year) | NYC Open Data PLUTO | none |
| Hydrants | NYC Open Data Fire Hydrants | none |
| Firehouses | NYC Open Data FDNY Firehouse Listing | none |

Any Open Data failure degrades gracefully: log, show a "layer unavailable" chip, never crash.

## Demo scope

Polished experience: Lower Manhattan below Canal St. Seed addresses: 26 Federal Plaza, 1 World Trade Center, 100 Gold Street. One-click scenario: "Structural fire, 100 Gold St."

## Visual identity

Dark tactical console: background #0a0e14, cyan (#22d3ee) primary / amber (#f59e0b) alert accents, Inter for UI, JetBrains Mono for data readouts, thin glowing borders, glass panels floating over the globe. Anduril-grade, never Bootstrap-grade.

## Unit taxonomy (used everywhere)

FDNY Engine (red square) · FDNY Ladder (red diamond) · FDNY Battalion/Command (white-on-red star) · Rescue/Squad (dark red) · EMS BLS/ALS (blue cross) · NYPD patrol (navy circle) · NYPD ESU (navy diamond) · OEM (orange pentagon) · Drone (cyan rotor). Labels are unit names: E-10, L-118, BC-01, etc.

## Build order

Phases 1–8 arrive as separate prompts. Complete the current phase's acceptance criteria before accepting new work. If a prompt conflicts with this file, this file wins except where the prompt explicitly says "override CLAUDE.md".
