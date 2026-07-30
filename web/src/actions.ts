import * as Cesium from 'cesium'
import { fetchBuildingSafety, fetchFirehouses, fetchHydrants, fetchPluto } from './api/nyc'
import { fetchFootprints, footprintContaining } from './cesium/footprints'
import { flyToTactical } from './cesium/providers'
import {
  getBoundaryLayer,
  getDrawController,
  getFootprintLayer,
  getIntelLayer,
  getScene,
  getShapeLayer,
  getUnitLayer,
} from './cesium/scene'
import { getAppState, setAppState, setLayerStatus } from './state/store'
import type { GeoHit, IcsShape, Incident, IncidentType, ToggleLayerId, UnitCategory } from './types'

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

  // Fresh incident, fresh overlay: clear local shapes and suggest the initial
  // 75 m hot zone (server-side shape list was reset by the incident POST).
  // targetHeightM resets too — a stale height would mis-size the collapse tool
  // until the new footprints load.
  setAppState({ shapes: {}, selectedShapeId: null, drawTool: null, targetHeightM: null })
  getShapeLayer()?.clear()
  suggestHotZone(incident)
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
    // Remember the target's height — it drives the collapse-zone tool (1.5x rule).
    const target = feats.find((f) => f.bin === targetBin)
    setAppState({ targetHeightM: target?.heightM ?? null })
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
  setLayerStatus('safety', 'loading')

  void (async () => {
    try {
      const safety = incident.bin ? await fetchBuildingSafety(incident.bin) : null
      setAppState((s) => ({ intel: { ...s.intel, safety } }))
      setLayerStatus('safety', 'ok')
    } catch (err) {
      console.error('[safety] layer unavailable:', err)
      setAppState((s) => ({ intel: { ...s.intel, safety: null } }))
      setLayerStatus('safety', 'unavailable')
    }
  })()

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

/** Layer visibility chips (Footprints / Hydrants / Firehouses / FDNY boundaries). */
export function toggleLayer(layer: ToggleLayerId): void {
  const next = !getAppState().layerToggles[layer]
  setAppState((s) => ({ layerToggles: { ...s.layerToggles, [layer]: next } }))
  if (layer === 'footprints') getFootprintLayer()?.setVisible(next)
  if (layer === 'hydrants') getIntelLayer()?.setHydrantsVisible(next)
  if (layer === 'firehouses') getIntelLayer()?.setFirehousesVisible(next)
  if (layer === 'battalions' || layer === 'divisions') {
    getBoundaryLayer()
      ?.setVisible(layer, next)
      .catch((err) => {
        console.error(`[boundaries] ${layer} unavailable:`, err)
        setAppState((s) => ({ layerToggles: { ...s.layerToggles, [layer]: false } }))
      })
  }
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

// ---------------------------------------------------------------------------
// Units (Phase 4): dispatch, roster interactions
// ---------------------------------------------------------------------------

/** Roster row click: chase the unit's live position. */
export function flyToUnit(uid: string): void {
  const unit = getAppState().units[uid]
  if (unit) flyToFeature(unit.lat, unit.lon)
}

/** Per-category visibility toggle (roster group headers). */
export function toggleUnitCategory(category: UnitCategory): void {
  const state = getAppState()
  const next = !state.unitToggles[category]
  setAppState((s) => ({ unitToggles: { ...s.unitToggles, [category]: next } }))
  getUnitLayer()?.setCategoryVisible(category, next, Object.values(state.units))
}

// ---------------------------------------------------------------------------
// ICS shapes (Phase 5)
// ---------------------------------------------------------------------------

/** Persist + broadcast + CoT-publish one shape (create or vertex edit). */
export async function saveShape(shape: IcsShape): Promise<void> {
  // Optimistic local apply; the WS echo is idempotent.
  setAppState((s) => ({ shapes: { ...s.shapes, [shape.id]: shape } }))
  getShapeLayer()?.upsert(shape)
  try {
    const res = await fetch(`/api/shapes/${encodeURIComponent(shape.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(shape),
    })
    if (!res.ok) throw new Error(`shapes PUT ${res.status}`)
  } catch (err) {
    console.error('[shapes] save failed:', err)
    setLayerStatus('persistence', 'unavailable')
  }
}

export async function deleteShape(id: string): Promise<void> {
  setAppState((s) => {
    const shapes = { ...s.shapes }
    delete shapes[id]
    return { shapes }
  })
  getShapeLayer()?.remove(id)
  try {
    await fetch(`/api/shapes/${encodeURIComponent(id)}`, { method: 'DELETE' })
  } catch (err) {
    console.error('[shapes] delete failed:', err)
  }
}

export function setDrawTool(tool: ReturnType<typeof getAppState>['drawTool']): void {
  const current = getAppState().drawTool
  getDrawController()?.cancelDraft()
  setAppState({ drawTool: current === tool ? null : tool, selectedShapeId: null })
  getDrawController()?.renderHandles()
}

export function deleteSelectedShape(): void {
  const id = getAppState().selectedShapeId
  if (!id) return
  void deleteShape(id)
  setAppState({ selectedShapeId: null })
  getDrawController()?.renderHandles()
}

/**
 * Auto-suggested initial perimeter: a 75 m hot-zone circle around the incident
 * (spec F3). A real, editable, deletable shape like any hand-drawn zone.
 */
function suggestHotZone(incident: Incident): void {
  const R_EARTH = 6371008.8
  const radius = 75
  const positions: { lat: number; lon: number }[] = []
  for (let i = 0; i < 20; i++) {
    const theta = (i / 20) * 2 * Math.PI
    const dLat = ((radius * Math.cos(theta)) / R_EARTH) * (180 / Math.PI)
    const dLon = ((radius * Math.sin(theta)) / (R_EARTH * Math.cos((incident.lat * Math.PI) / 180))) * (180 / Math.PI)
    positions.push({ lat: incident.lat + dLat, lon: incident.lon + dLon })
  }
  void saveShape({
    id: `WT-ICS-ZONE-HOT-AUTO-${incident.id}`,
    kind: 'zone',
    zone: 'hot',
    positions,
    createdAt: new Date().toISOString(),
  })
}

/**
 * One-click demo (Phase 8): full flow unattended — geocode 100 Gold St,
 * stand up the incident (fly-in, intel, auto-perimeter), then dispatch.
 * Comms channels are always rolling.
 */
export async function runDemoScenario(): Promise<void> {
  try {
    const { autocompleteAddress } = await import('./api/geosearch')
    const hits = await autocompleteAddress('100 Gold Street')
    const hit = hits.find((h) => h.borough === 'Manhattan') ?? hits[0]
    if (!hit) throw new Error('geocoder returned nothing for 100 Gold Street')
    await standUpIncident(hit, 'Structural Fire')
    // Let the fly-in land and the perimeter draw before units start rolling.
    setTimeout(() => void dispatchAssignment(), 4000)
  } catch (err) {
    console.error('[demo] scenario failed:', err)
  }
}

/** "Dispatch Assignment" — the server spawns the simulated first alarm. */
export async function dispatchAssignment(): Promise<void> {
  setAppState({ dispatching: true })
  try {
    const res = await fetch('/api/dispatch', { method: 'POST' })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      throw new Error(body?.error ?? `dispatch ${res.status}`)
    }
  } catch (err) {
    console.error('[dispatch] failed:', err)
  } finally {
    setAppState({ dispatching: false })
  }
}
