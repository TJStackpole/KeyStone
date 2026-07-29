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
| 3 | TAK spine (CoT in/out through real TAK server) | — |
| 4 | First-alarm simulator + unit roster | — |
| 5 | ICS perimeter + command post tools | — |
| 6 | Video: drones + body-cam wall (MediaMTX) | — |
| 7 | Comms fusion + live transcription | — |
| 8 | Command header, demo scenario, replay, polish | — |
