import * as Cesium from 'cesium'
import { fetchFirehouses, fetchHydrants, fetchPluto } from './api/nyc'
import { fetchFootprints, footprintContaining } from './cesium/footprints'
import { flyToTactical } from './cesium/providers'
import { getFootprintLayer, getIntelLayer, getScene } from './cesium/scene'
import { getAppState, setAppState, setLayerStatus } from './state/store'
import type { GeoHit, Incident, IncidentType, ToggleLayerId } from './types'

function newIncidentId(): string {
  return `INC-${Date.now().toString(36).toUpperCase()}`
}

/**
 * F1 bootstrap: address hit -> tactical fly-to, incident record, extruded
 * footprints with the target building highlighted, persistence to the server.
 */
export async function standUpIncident(hit: GeoHit, type: IncidentType = 'Structural Fire'): Promise<void> {
  const incident: Incident = {
    id: newIncidentId(),
    address: hit.label,
    bin: hit.bin,
    bbl: hit.bbl,
    borough: hit.borough,
    lat: hit.lat,
    lon: hit.lon,
    type,
    createdAt: new Date().toISOString(),
  }
  setAppState({ incident })

  const scene = getScene()
  if (scene) flyToTactical(scene.viewer, hit.lat, hit.lon)

  // These run concurrently; each degrades independently per the CLAUDE.md rule.
  void loadFootprints(incident)
  void loadSiteIntel(incident)
  void persistIncident(incident)
}

export async function changeIncidentType(type: IncidentType): Promise<void> {
  setAppState((s) => ({ incident: s.incident ? { ...s.incident, type } : null }))
  try {
    await fetch('/api/incident', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type }),
    })
  } catch (err) {
    console.error('[incident] type patch failed:', err)
  }
}

async function loadFootprints(incident: Incident): Promise<void> {
  const scene = getScene()
  const layer = getFootprintLayer()
  if (!scene || !layer) return
  setLayerStatus('footprints', 'loading')
  try {
    const feats = await fetchFootprints(incident.lat, incident.lon, 250)
    // Prefer the PAD BIN from geocoding; fall back to point-in-polygon.
    const targetBin =
      incident.bin && feats.some((f) => f.bin === incident.bin)
        ? incident.bin
        : footprintContaining(incident.lon, incident.lat, feats)?.bin
    layer.render(feats, targetBin, scene.extrudeFootprints)
    setLayerStatus('footprints', 'ok')
    console.log(`[footprints] ${feats.length} footprints, target BIN ${targetBin ?? 'not resolved'}`)
  } catch (err) {
    console.error('[footprints] layer unavailable:', err)
    layer.clear()
    setLayerStatus('footprints', 'unavailable')
  }
}

async function persistIncident(incident: Incident): Promise<void> {
  setLayerStatus('persistence', 'loading')
  try {
    const res = await fetch('/api/incident', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(incident),
    })
    if (!res.ok) throw new Error(`server ${res.status}`)
    setLayerStatus('persistence', 'ok')
  } catch (err) {
    console.error('[incident] persistence unavailable:', err)
    setLayerStatus('persistence', 'unavailable')
  }
}

/** On boot, restore a persisted incident (refresh survives). */
export async function restoreIncident(): Promise<void> {
  try {
    const res = await fetch('/api/incident')
    if (!res.ok) return
    const body = (await res.json()) as { incident: Incident | null }
    if (!body.incident) return
    setAppState({ incident: body.incident })
    setLayerStatus('persistence', 'ok')
    const scene = getScene()
    if (scene) flyToTactical(scene.viewer, body.incident.lat, body.incident.lon)
    void loadFootprints(body.incident)
    void loadSiteIntel(body.incident)
  } catch {
    // Server not up yet — fine, the operator can still search.
  }
}

// ---------------------------------------------------------------------------
// Site intel (Phase 2): PLUTO attributes + nearest hydrants/firehouses
// ---------------------------------------------------------------------------

async function loadSiteIntel(incident: Incident): Promise<void> {
  const intel = getIntelLayer()

  setLayerStatus('pluto', 'loading')
  setLayerStatus('hydrants', 'loading')
  setLayerStatus('firehouses', 'loading')

  void (async () => {
    try {
      const pluto = incident.bbl ? await fetchPluto(incident.bbl) : null
      setAppState((s) => ({ intel: { ...s.intel, pluto } }))
      setLayerStatus('pluto', 'ok')
    } catch (err) {
      console.error('[pluto] layer unavailable:', err)
      setAppState((s) => ({ intel: { ...s.intel, pluto: null } }))
      setLayerStatus('pluto', 'unavailable')
    }
  })()

  void (async () => {
    try {
      const hydrants = await fetchHydrants(incident.lat, incident.lon, 300)
      setAppState((s) => ({ intel: { ...s.intel, hydrants } }))
      intel?.setHydrants(hydrants)
      setLayerStatus('hydrants', 'ok')
    } catch (err) {
      console.error('[hydrants] layer unavailable:', err)
      setAppState((s) => ({ intel: { ...s.intel, hydrants: [] } }))
      intel?.setHydrants([])
      setLayerStatus('hydrants', 'unavailable')
    }
  })()

  void (async () => {
    try {
      const firehouses = await fetchFirehouses(incident.lat, incident.lon)
      setAppState((s) => ({ intel: { ...s.intel, firehouses } }))
      // Globe markers: only the nearest three (the responding houses); the full
      // sorted list stays in state for the Phase 4 simulator.
      intel?.setFirehouses(firehouses.slice(0, 3))
      setLayerStatus('firehouses', 'ok')
    } catch (err) {
      console.error('[firehouses] layer unavailable:', err)
      setAppState((s) => ({ intel: { ...s.intel, firehouses: [] } }))
      intel?.setFirehouses([])
      setLayerStatus('firehouses', 'unavailable')
    }
  })()
}

/** Layer visibility chips (Footprints / Hydrants / Firehouses). */
export function toggleLayer(layer: ToggleLayerId): void {
  const next = !getAppState().layerToggles[layer]
  setAppState((s) => ({ layerToggles: { ...s.layerToggles, [layer]: next } }))
  if (layer === 'footprints') getFootprintLayer()?.setVisible(next)
  if (layer === 'hydrants') getIntelLayer()?.setHydrantsVisible(next)
  if (layer === 'firehouses') getIntelLayer()?.setFirehousesVisible(next)
}

/** Close-in look at a single intel feature (hydrant / firehouse row click). */
export function flyToFeature(lat: number, lon: number): void {
  const scene = getScene()
  if (!scene) return
  const altitude = 220
  const standoffDeg = altitude / 111_320
  scene.viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat - standoffDeg, altitude),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
    duration: 1.6,
  })
}
