import * as Cesium from 'cesium'
import {
  fetchBuildingSafety,
  fetchCertificatesOfOccupancy,
  fetchFirehouses,
  fetchHydrants,
  fetchPluto,
  fetchStreetLabels,
} from './api/nyc'
import { reverseGeocode } from './api/geosearch'
import { fetchFootprints, footprintContaining } from './cesium/footprints'
import { flyToTactical } from './cesium/providers'
import { exitGroundView, setTopDown } from './cesium/viewmode'
import {
  getBoundaryLayer,
  getDrawController,
  getFocusLayer,
  getFootprintLayer,
  getIntelLayer,
  getScene,
  getShapeLayer,
  getStreetLayer,
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
  // A stale top-down/ground camera would fight the tactical fly-in; the
  // exits restore controller settings, then the tactical flight wins.
  if (getAppState().groundViewActive) exitGround()
  if (getAppState().viewMode === 'topdown' && scene) {
    setAppState({ viewMode: '3d' })
    void setTopDown(scene, false)
  }
  if (scene) flyToTactical(scene.viewer, hit.lat, hit.lon)

  // These run concurrently; each degrades independently per the CLAUDE.md rule.
  void loadFootprints(incident)
  void loadSiteIntel(incident)
  void persistIncident(incident)

  // ACTIVE INCIDENT focus: sharpen the fire building, de-emphasize >4 blocks.
  getFocusLayer()?.apply(incident, getAppState().activeIncidentMode)

  // Fresh incident, fresh overlay: clear local shapes (server-side list was
  // reset by the incident POST). Zones are drawn manually by the chief — no
  // auto-suggested perimeter. targetHeightM resets too — a stale height would
  // mis-size the collapse tool until the new footprints load.
  setAppState({ shapes: {}, selectedShapeId: null, drawTool: null, targetHeightM: null, inspected: null })
  getShapeLayer()?.clear()
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
    getFocusLayer()?.apply(body.incident, getAppState().activeIncidentMode)
  } catch {
    // Server not up yet — fine, the operator can still search.
  }
}

/** ACTIVE INCIDENT chip: toggle the focus treatment on/off. */
export function toggleActiveIncidentMode(): void {
  const next = !getAppState().activeIncidentMode
  setAppState({ activeIncidentMode: next })
  getFocusLayer()?.apply(getAppState().incident, next)
}

/** Provider chip: cycle the camera between tactical 3D and top-down satellite. */
export async function toggleTopDownView(): Promise<void> {
  const scene = getScene()
  if (!scene) return
  // Street-level and top-down don't stack — leave the ground camera first
  // (restores zoom/collision settings), then the top-down flight wins.
  if (getAppState().groundViewActive) exitGround()
  const next = getAppState().viewMode === 'topdown' ? '3d' : 'topdown'
  setAppState({ viewMode: next })
  const inc = getAppState().incident
  await setTopDown(scene, next === 'topdown', inc ? { lat: inc.lat, lon: inc.lon } : undefined)
}

/** Leave the street-level camera and restore the view it replaced. */
export function exitGround(): void {
  const scene = getScene()
  if (scene) exitGroundView(scene.viewer)
  setAppState({ groundViewActive: false })
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
      // Street/avenue captions — photorealistic tiles carry no map labels.
      const streets = await fetchStreetLabels(incident.lat, incident.lon)
      const layer = getStreetLayer()
      layer?.set(streets)
      layer?.setVisible(getAppState().layerToggles.streets)
    } catch (err) {
      console.error('[streets] labels unavailable:', err)
      getStreetLayer()?.clear()
    }
  })()

  void (async () => {
    try {
      const cofo = incident.bin ? await fetchCertificatesOfOccupancy(incident.bin) : []
      setAppState((s) => ({ intel: { ...s.intel, cofo } }))
    } catch (err) {
      console.error('[cofo] records unavailable:', err)
      setAppState((s) => ({ intel: { ...s.intel, cofo: [] } }))
    }
  })()

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
      // Hydrant picture stays tight to the fire — a couple of Manhattan blocks.
      const hydrants = await fetchHydrants(incident.lat, incident.lon, 180)
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
  if (layer === 'streets') getStreetLayer()?.setVisible(next)
  if (layer === 'battalions' || layer === 'divisions') {
    getBoundaryLayer()
      ?.setVisible(layer, next)
      .catch((err) => {
        console.error(`[boundaries] ${layer} unavailable:`, err)
        setAppState((s) => ({ layerToggles: { ...s.layerToggles, [layer]: false } }))
      })
  }
}

// ---------------------------------------------------------------------------
// Tap-a-building intel: reverse-geocode a map click to the nearest address
// (BIN/BBL) and pull that building's public record — PLUTO, violations, and
// Certificates of Occupancy. Full blueprints are not public in NYC; C of O
// is the floor-by-floor legal record a chief can actually get.
// ---------------------------------------------------------------------------

let inspectSeq = 0

export async function inspectBuildingAt(lat: number, lon: number): Promise<void> {
  const seq = ++inspectSeq
  let hit: GeoHit | null = null
  try {
    hit = await reverseGeocode(lat, lon)
  } catch (err) {
    console.error('[inspect] reverse geocode unavailable:', err)
    return
  }
  if (!hit || seq !== inspectSeq) return
  const incident = getAppState().incident
  // Tapping the incident building itself just returns the panel to it.
  if (incident?.bin && hit.bin && incident.bin === hit.bin) {
    setAppState({ inspected: null })
    return
  }
  setAppState({ inspected: { hit, loading: true, pluto: null, safety: null, cofo: [] } })
  const [pluto, safety, cofo] = await Promise.all([
    hit.bbl ? fetchPluto(hit.bbl).catch(() => null) : Promise.resolve(null),
    hit.bin ? fetchBuildingSafety(hit.bin).catch(() => null) : Promise.resolve(null),
    hit.bin ? fetchCertificatesOfOccupancy(hit.bin).catch(() => []) : Promise.resolve([]),
  ])
  if (seq !== inspectSeq) return
  const current = getAppState().inspected
  if (!current || current.hit !== hit) return
  setAppState({ inspected: { hit, loading: false, pluto, safety, cofo } })
}

export function clearInspected(): void {
  inspectSeq++
  setAppState({ inspected: null })
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

/** Roster row click: chase the unit's live position (and reveal its label). */
export function flyToUnit(uid: string): void {
  const unit = getAppState().units[uid]
  if (!unit) return
  getUnitLayer()?.showLabel(uid)
  flyToFeature(unit.lat, unit.lon)
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
    // Give the simulator the building profile so interior crews work real floors.
    const floors = getAppState().intel.pluto?.numFloors
    const res = await fetch('/api/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ floors }),
    })
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
