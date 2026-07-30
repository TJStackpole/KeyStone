import * as Cesium from 'cesium'
import {
  fetchBuildingSafety,
  fetchCertificatesOfOccupancy,
  fetchFirehouses,
  fetchHydrants,
  fetchPluto,
  fetchStreetLabels,
  fetchTrafficLinks,
} from './api/nyc'
import { reverseGeocode } from './api/geosearch'
import { fetchFootprints, footprintContaining, type Footprint } from './cesium/footprints'
import { flyToTactical } from './cesium/providers'
import { exitGroundView, setGroundViewHeight, setTopDown } from './cesium/viewmode'
import {
  getBoundaryLayer,
  getDrawController,
  getFocusLayer,
  getFootprintLayer,
  getIntelLayer,
  getExposureLayer,
  getScene,
  getShapeLayer,
  getStreetLayer,
  getTrafficLayer,
  getUnitLayer,
} from './cesium/scene'
import { replayEngine } from './replay'
import { getAppState, setAppState, setLayerStatus } from './state/store'
import type { Agency, GeoHit, IcsShape, Incident, IncidentType, ToggleLayerId, Unit, UnitCategory } from './types'

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
  resetIsolate()
  lastFootprints = null
  getTrafficLayer()?.clear() // stale polylines from the previous location
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

/** Last rendered footprint set — ISOLATE mode clips the tileset to the target. */
let lastFootprints: { incidentId: string; feats: Footprint[]; targetBin?: string } | null = null

async function loadFootprints(incident: Incident): Promise<void> {
  const scene = getScene()
  const layer = getFootprintLayer()
  if (!scene || !layer) return
  setLayerStatus('footprints', 'loading')
  try {
    const feats = await fetchFootprints(incident.lat, incident.lon, 250)
    // Stale-guard: the incident may have changed (or been ended) mid-fetch.
    if (getAppState().incident?.id !== incident.id) return
    // Prefer the PAD BIN from geocoding; fall back to point-in-polygon.
    const targetBin =
      incident.bin && feats.some((f) => f.bin === incident.bin)
        ? incident.bin
        : footprintContaining(incident.lon, incident.lat, feats)?.bin
    lastFootprints = { incidentId: incident.id, feats, targetBin }
    void layer.render(feats, targetBin, scene.extrudeFootprints && !getAppState().isolateMode)
    // Remember the target's height — it drives the collapse-zone tool (1.5x rule).
    const target = feats.find((f) => f.bin === targetBin)
    setAppState({ targetHeightM: target?.heightM ?? null })
    setLayerStatus('footprints', 'ok')
    // Self-heal ISOLATE: if the operator toggled it while footprints were in
    // flight, re-apply the clip against the freshly resolved target.
    if (getAppState().isolateMode) applyIsolate(true)
    console.log(`[footprints] ${feats.length} footprints, target BIN ${targetBin ?? 'not resolved'}`)
  } catch (err) {
    console.error('[footprints] layer unavailable:', err)
    if (getAppState().incident?.id !== incident.id) return
    lastFootprints = null
    resetIsolate() // a clip against vanished data is worse than no clip
    layer.clear()
    setLayerStatus('footprints', 'unavailable')
  }
}

// ---------------------------------------------------------------------------
// ISOLATE mode: strip every building, tree, and obstruction except the
// incident building. On photorealistic/OSM tilesets this uses inverse
// clipping polygons (the tileset renders ONLY inside the target footprint,
// so the REAL building stands alone); keyless mode simply stops extruding
// the neighbors. Available while ACTIVE INCIDENT focus is on.
// ---------------------------------------------------------------------------

export function toggleIsolateMode(): void {
  const scene = getScene()
  const on = !getAppState().isolateMode
  if (!scene) return
  const current = getAppState().incident
  const cacheValid = !!lastFootprints?.targetBin && lastFootprints.incidentId === current?.id
  if (on && !cacheValid) {
    console.warn(
      `[isolate] refused: footprint cache ${lastFootprints ? `is for ${lastFootprints.incidentId} (current ${current?.id})` : 'is empty'}`,
    )
    return
  }
  setAppState({ isolateMode: on })
  applyIsolate(on)
  if (on) frameIsolatedBuilding()
}

if (import.meta.env.DEV) {
  // Debug handle: lets DevTools (and our own probes) see the isolate inputs.
  ;(window as unknown as Record<string, unknown>).__wtIsolate = {
    cache: () => lastFootprints,
    toggle: toggleIsolateMode,
  }
}

/** How high ISOLATE levitates the building above the flattened city. */
function isolateLiftM(): number {
  const h = getAppState().targetHeightM ?? 30
  return Math.min(80, Math.max(35, h * 0.5))
}

/**
 * Visual settings ISOLATE overrides for a size-up-quality facade: with one
 * building on screen we can afford ultra tile refinement and native-resolution
 * rendering that would be too heavy for the whole city. The OFF path restores
 * to KNOWN defaults (not a saved snapshot — module state dies on dev reloads).
 */
function boostIsolateVisuals(on: boolean): void {
  const scene = getScene()
  if (!scene) return
  const viewer = scene.viewer
  const tileset = scene.buildingTileset
  if (on) {
    if (tileset) {
      tileset.maximumScreenSpaceError = 2 // ultra refinement — one building only
      tileset.dynamicScreenSpaceError = false // no distance falloff for a lone target
      tileset.foveatedScreenSpaceError = false // sharpen screen edges too
      tileset.cacheBytes = 1024 * 1024 * 1024
    }
    // Render at native device pixels (Cesium defaults to CSS pixels — soft on
    // retina displays). Fine here: the clipped scene is one building.
    viewer.useBrowserRecommendedResolution = false
  } else {
    if (tileset) {
      tileset.foveatedScreenSpaceError = true // Cesium default
      tileset.cacheBytes = 512 * 1024 * 1024 // Cesium default
    }
    viewer.useBrowserRecommendedResolution = true
    // FocusLayer owns SSE outside isolate — reassert its current policy.
    const s = getAppState()
    getFocusLayer()?.apply(s.incident, s.activeIncidentMode)
  }
}

/** Frame the isolated building at size-up distance, facade filling the view. */
function frameIsolatedBuilding(): void {
  const scene = getScene()
  const inc = getAppState().incident
  if (!scene || !inc) return
  const h = getAppState().targetHeightM ?? 30
  const lift = isolateLiftM()
  const target = lastFootprints?.feats.find((f) => f.bin === lastFootprints?.targetBin)
  // Horizontal extent from the footprint bbox (fallback: assume a rowhouse).
  let extentM = 30
  const outer = target?.polygons[0]?.[0]
  if (outer?.length) {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
    for (const [lon, lat] of outer) {
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon)
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
    }
    extentM = Math.max(
      (maxLat - minLat) * 111_320,
      (maxLon - minLon) * 111_320 * Math.cos((inc.lat * Math.PI) / 180),
      15,
    )
  }
  const groundHae = scene.viewer.scene.sampleHeight?.(Cesium.Cartographic.fromDegrees(inc.lon, inc.lat))
  const base = Number.isFinite(groundHae) ? (groundHae as number) : -30
  const center = Cesium.Cartesian3.fromDegrees(inc.lon, inc.lat, base + lift + h / 2)
  const radius = Math.max(extentM / 2, h / 2) + 12
  scene.viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, radius), {
    offset: new Cesium.HeadingPitchRange(scene.viewer.camera.heading, Cesium.Math.toRadians(-18), radius * 3.4),
    duration: 1.4,
  })
}

function applyIsolate(on: boolean): void {
  const scene = getScene()
  if (!scene) return
  const tileset = scene.buildingTileset
  if (tileset) {
    if (on && lastFootprints?.targetBin) {
      const target = lastFootprints.feats.find((f) => f.bin === lastFootprints?.targetBin)
      const polygons = (target?.polygons ?? []).map(
        (poly) =>
          new Cesium.ClippingPolygon({
            positions: Cesium.Cartesian3.fromDegreesArray(poly[0].flat()),
          }),
      )
      if (polygons.length) {
        tileset.clippingPolygons = new Cesium.ClippingPolygonCollection({ polygons, inverse: true })
        // Raise the lone building above the flattened city: translate the
        // (fully clipped) tileset along the local up vector. Only the target
        // survives the clip, so only it visibly lifts.
        const inc = getAppState().incident
        if (inc) {
          const up = Cesium.Cartesian3.normalize(
            Cesium.Cartesian3.fromDegrees(inc.lon, inc.lat),
            new Cesium.Cartesian3(),
          )
          const lift = Cesium.Cartesian3.multiplyByScalar(up, isolateLiftM(), new Cesium.Cartesian3())
          tileset.modelMatrix = Cesium.Matrix4.fromTranslation(lift)
        }
        // The globe is hidden in google mode (clamp correctness) — isolate
        // needs it back as the flattened-map ground under the lone building.
        scene.viewer.scene.globe.show = true
      }
    } else {
      tileset.clippingPolygons = new Cesium.ClippingPolygonCollection({ polygons: [] })
      tileset.modelMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY)
      if (scene.mode === 'google') scene.viewer.scene.globe.show = false
    }
  }
  // Size-up-quality imagery while isolated; restores itself (and the focus
  // layer's SSE policy) on the way out.
  boostIsolateVisuals(on)
  // Keyless: the neighbors are our own extrusions — just stop drawing them.
  if (lastFootprints && scene.extrudeFootprints) {
    void getFootprintLayer()?.render(lastFootprints.feats, lastFootprints.targetBin, !on)
  }
}

/** Shared teardown: ACTIVE INCIDENT off, new incident, or END all clear isolate. */
export function resetIsolate(): void {
  if (!getAppState().isolateMode) return
  setAppState({ isolateMode: false })
  applyIsolate(false)
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
  if (!next) resetIsolate() // ISOLATE rides on active-incident focus
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

/** Ground-view eye height (0–50 ft): remembered for the next drop, live while down. */
export function setGroundHeightFt(ft: number): void {
  const clamped = Math.min(50, Math.max(0, Math.round(ft)))
  setAppState({ groundViewFt: clamped })
  const scene = getScene()
  if (scene && getAppState().groundViewActive) setGroundViewHeight(scene.viewer, clamped)
}

// ---------------------------------------------------------------------------
// Site intel (Phase 2): PLUTO attributes + nearest hydrants/firehouses
// ---------------------------------------------------------------------------

async function loadSiteIntel(incident: Incident): Promise<void> {
  const intel = getIntelLayer()
  // Every sub-fetch checks this after awaiting: a late result for an ended or
  // superseded incident must not repopulate a board that moved on.
  const stillCurrent = () => getAppState().incident?.id === incident.id

  setLayerStatus('pluto', 'loading')
  setLayerStatus('hydrants', 'loading')
  setLayerStatus('firehouses', 'loading')
  setLayerStatus('safety', 'loading')

  void (async () => {
    try {
      // Street/avenue captions — photorealistic tiles carry no map labels.
      const streets = await fetchStreetLabels(incident.lat, incident.lon)
      if (!stillCurrent()) return
      const layer = getStreetLayer()
      layer?.set(streets)
      layer?.setVisible(getAppState().layerToggles.streets)
    } catch (err) {
      console.error('[streets] labels unavailable:', err)
      if (stillCurrent()) getStreetLayer()?.clear()
    }
  })()

  void (async () => {
    try {
      const cofo = incident.bin ? await fetchCertificatesOfOccupancy(incident.bin) : []
      if (!stillCurrent()) return
      setAppState((s) => ({ intel: { ...s.intel, cofo } }))
    } catch (err) {
      console.error('[cofo] records unavailable:', err)
      if (stillCurrent()) setAppState((s) => ({ intel: { ...s.intel, cofo: [] } }))
    }
  })()

  // Traffic follows the incident to its new location when the layer is on.
  void refreshTraffic()

  void (async () => {
    try {
      const safety = incident.bin ? await fetchBuildingSafety(incident.bin) : null
      if (!stillCurrent()) return
      setAppState((s) => ({ intel: { ...s.intel, safety } }))
      setLayerStatus('safety', 'ok')
    } catch (err) {
      console.error('[safety] layer unavailable:', err)
      if (!stillCurrent()) return
      setAppState((s) => ({ intel: { ...s.intel, safety: null } }))
      setLayerStatus('safety', 'unavailable')
    }
  })()

  void (async () => {
    try {
      const pluto = incident.bbl ? await fetchPluto(incident.bbl) : null
      if (!stillCurrent()) return
      setAppState((s) => ({ intel: { ...s.intel, pluto } }))
      setLayerStatus('pluto', 'ok')
    } catch (err) {
      console.error('[pluto] layer unavailable:', err)
      if (!stillCurrent()) return
      setAppState((s) => ({ intel: { ...s.intel, pluto: null } }))
      setLayerStatus('pluto', 'unavailable')
    }
  })()

  void (async () => {
    try {
      // Hydrant picture stays tight to the fire — a couple of Manhattan blocks.
      const hydrants = await fetchHydrants(incident.lat, incident.lon, 180)
      if (!stillCurrent()) return
      setAppState((s) => ({ intel: { ...s.intel, hydrants } }))
      intel?.setHydrants(hydrants)
      setLayerStatus('hydrants', 'ok')
    } catch (err) {
      console.error('[hydrants] layer unavailable:', err)
      if (!stillCurrent()) return
      setAppState((s) => ({ intel: { ...s.intel, hydrants: [] } }))
      intel?.setHydrants([])
      setLayerStatus('hydrants', 'unavailable')
    }
  })()

  void (async () => {
    try {
      const firehouses = await fetchFirehouses(incident.lat, incident.lon)
      if (!stillCurrent()) return
      setAppState((s) => ({ intel: { ...s.intel, firehouses } }))
      // Globe markers: only the nearest three (the responding houses); the full
      // sorted list stays in state for the Phase 4 simulator.
      intel?.setFirehouses(firehouses.slice(0, 3))
      setLayerStatus('firehouses', 'ok')
    } catch (err) {
      console.error('[firehouses] layer unavailable:', err)
      if (!stillCurrent()) return
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
  if (layer === 'targetbox') getFootprintLayer()?.setTargetVisible(next)
  if (layer === 'hydrants') getIntelLayer()?.setHydrantsVisible(next)
  if (layer === 'firehouses') getIntelLayer()?.setFirehousesVisible(next)
  if (layer === 'streets') getStreetLayer()?.setVisible(next)
  if (layer === 'traffic') {
    getTrafficLayer()?.setVisible(next)
    if (next) void refreshTraffic()
  }
  if (layer === 'battalions' || layer === 'divisions') {
    getBoundaryLayer()
      ?.setVisible(layer, next)
      .catch((err) => {
        console.error(`[boundaries] ${layer} unavailable:`, err)
        setAppState((s) => ({ layerToggles: { ...s.layerToggles, [layer]: false } }))
      })
  }
}

/**
 * Stand up an incident that arrived from the SERVER (scenario load) — same
 * local treatment as an operator search: fly-in, footprints, intel, focus.
 */
export function adoptIncident(incident: Incident): void {
  resetIsolate()
  lastFootprints = null
  getTrafficLayer()?.clear() // stale polylines from the previous location
  setAppState({
    incident,
    shapes: {},
    selectedShapeId: null,
    drawTool: null,
    targetHeightM: null,
    inspected: null,
    streetViewOpen: false,
  })
  getShapeLayer()?.clear()
  const scene = getScene()
  if (getAppState().groundViewActive) exitGround()
  if (getAppState().viewMode === 'topdown' && scene) {
    setAppState({ viewMode: '3d' })
    void setTopDown(scene, false)
  }
  if (scene) flyToTactical(scene.viewer, incident.lat, incident.lon)
  void loadFootprints(incident)
  void loadSiteIntel(incident)
  getFocusLayer()?.apply(incident, getAppState().activeIncidentMode)
}

// ---------------------------------------------------------------------------
// Scenario playback controls (Prompt 8A)
// ---------------------------------------------------------------------------

async function scenarioPost(path: string, body?: Record<string, unknown>): Promise<void> {
  try {
    const res = await fetch(`/api/scenario/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    if (!res.ok) throw new Error(`scenario ${path} ${res.status}`)
  } catch (err) {
    console.error('[scenario] control failed:', err)
  }
}

export async function loadScenario(name: string): Promise<void> {
  // Merged command view is the right default for multi-channel drill traffic.
  setAppState({ aarOpen: false, alert: null, nycemView: false, commsAll: true, commsOpen: true })
  await scenarioPost('load', { name })
  await scenarioPost('play')
}

export const playScenario = (): Promise<void> => scenarioPost('play')
export const pauseScenario = (): Promise<void> => scenarioPost('pause')
export const setScenarioSpeed = (x: number): Promise<void> => scenarioPost('speed', { x })
export const jumpScenarioChapter = (id: string): Promise<void> => scenarioPost('chapter', { id })

export async function stopScenario(): Promise<void> {
  await scenarioPost('stop')
  getExposureLayer()?.clear()
  setAppState({ scenario: null, alert: null, aarOpen: false })
}

/**
 * Cancel EVERYTHING — drill, demo dispatch, incident, shapes, units. One
 * escape hatch that always returns the platform to a clean searching state.
 */
export async function endIncident(): Promise<void> {
  try {
    const res = await fetch('/api/incident', { method: 'DELETE' })
    if (!res.ok) {
      // Server refused — its sim/scenario would instantly repopulate a wiped
      // board, so keep local state honest and bail.
      console.error(`[incident] end refused by server (${res.status})`)
      return
    }
  } catch (err) {
    // Server unreachable — nothing is broadcasting, safe to clear locally.
    console.error('[incident] end: server unreachable, clearing locally:', err)
  }
  clearLocalIncident()
}

/** Local teardown shared by endIncident and the ws incident:null broadcast. */
export function clearLocalIncident(): void {
  // A running replay owns the globe and its EXIT control lives on the
  // incident UI — ending the incident must end the replay too.
  if (getAppState().replay.active) replayEngine.stop()
  resetIsolate()
  lastFootprints = null
  setAppState({
    incident: null,
    shapes: {},
    selectedShapeId: null,
    drawTool: null,
    targetHeightM: null,
    inspected: null,
    scenario: null,
    alert: null,
    aarOpen: false,
    nycemView: false,
    streetViewOpen: false,
    units: {},
    intel: { pluto: null, hydrants: [], firehouses: [], safety: null, cofo: [] },
    timeline: [],
  })
  getShapeLayer()?.clear()
  getUnitLayer()?.clear()
  getFootprintLayer()?.clear()
  getIntelLayer()?.clear()
  getStreetLayer()?.clear()
  getExposureLayer()?.clear()
  getTrafficLayer()?.clear()
  getFocusLayer()?.apply(null, false)
  if (getAppState().groundViewActive) exitGround()
}

/** Rotate the selected staging pad in place (hint-bar buttons and [ ] keys). */
export function rotateSelectedApparatus(deltaDeg: number): void {
  const s = getAppState()
  const shape = s.selectedShapeId ? s.shapes[s.selectedShapeId] : null
  if (!shape || shape.kind !== 'apparatus') return
  void saveShape({ ...shape, heading: (shape.heading + deltaDeg + 360) % 360 })
}

/** Compass click: swing the camera back to north, rotating about the view center. */
export function reorientNorth(): void {
  const scene = getScene()
  if (!scene) return
  const viewer = scene.viewer
  const canvas = viewer.scene.canvas
  const center = viewer.camera.pickEllipsoid(
    new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    viewer.scene.globe.ellipsoid,
  )
  const pitch = Math.min(viewer.camera.pitch, Cesium.Math.toRadians(-10))
  if (center) {
    const range = Cesium.Cartesian3.distance(viewer.camera.position, center)
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, 1), {
      offset: new Cesium.HeadingPitchRange(0, pitch, range),
      duration: 0.8,
    })
  } else {
    viewer.camera.flyTo({
      destination: viewer.camera.position.clone(),
      orientation: { heading: 0, pitch: viewer.camera.pitch, roll: 0 },
      duration: 0.8,
    })
  }
}

/** NYCEM view: agency-level unit filters, ANDed with the category toggles. */
export function toggleAgency(agency: Agency): void {
  const next = !getAppState().agencyToggles[agency]
  setAppState((s) => ({ agencyToggles: { ...s.agencyToggles, [agency]: next } }))
  applyUnitVisibility()
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
  // The tapped address also lands in the search bar — one Enter away from
  // standing up a new incident there.
  setAppState({
    inspected: { hit, loading: true, pluto: null, safety: null, cofo: [] },
    searchPrefill: hit.label,
  })
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

// ---------------------------------------------------------------------------
// Live traffic (DOT Traffic Speeds NBE): refreshed every 60 s while the
// TRAFFIC layer is on and an incident exists. The interval is a permanent
// low-cost heartbeat — the gate conditions do the work.
// ---------------------------------------------------------------------------

let trafficTimer: ReturnType<typeof setInterval> | null = null

export async function refreshTraffic(): Promise<void> {
  const { incident, layerToggles } = getAppState()
  if (!incident || !layerToggles.traffic) return
  if (!trafficTimer) {
    trafficTimer = setInterval(() => void refreshTraffic(), 60_000)
  }
  try {
    // DOT's sensor network covers highways/major arterials only — if nothing
    // is near a residential incident, widen to show the approach corridors.
    let links = await fetchTrafficLinks(incident.lat, incident.lon, 2500)
    if (!links.length) links = await fetchTrafficLinks(incident.lat, incident.lon, 8000)
    // Stale-guard: the incident may have changed while the fetch was in flight.
    const now = getAppState()
    if (now.incident?.id !== incident.id || !now.layerToggles.traffic) return
    getTrafficLayer()?.set(links)
  } catch (err) {
    console.error('[traffic] layer unavailable:', err)
    // Same stale-guard as the success path — a late failure from a previous
    // incident must not wipe links a newer refresh already drew.
    const now = getAppState()
    if (now.incident?.id === incident.id && now.layerToggles.traffic) getTrafficLayer()?.clear()
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

/** Roster row click: chase the unit's live position (and reveal its label). */
export function flyToUnit(uid: string): void {
  const unit = getAppState().units[uid]
  if (!unit) return
  getUnitLayer()?.showLabel(uid)
  flyToFeature(unit.lat, unit.lon)
}

const PERSONNEL_CATEGORIES = new Set<UnitCategory>(['ff', 'officer', 'medic'])

/**
 * GPS tracking policy — the ONE place that decides whether a unit gets a dot
 * on the map. Current policy (per the chief): vehicles track for every
 * agency; individual member GPS only for firefighters INSIDE the building
 * (floor >= 1); other agencies' personnel are not tracked individually.
 * The GPS toggle kills all map tracking. Accountability boards (roster,
 * BIO, FLOORS) are unaffected — they're rosters, not GPS.
 */
export function unitMapVisible(u: Unit): boolean {
  const s = getAppState()
  if (!s.gpsTracking) return false
  if (!(s.unitToggles[u.category] ?? true)) return false
  if (!(s.agencyToggles[u.agency] ?? true)) return false
  if (PERSONNEL_CATEGORIES.has(u.category)) {
    return u.category === 'ff' && (u.floor ?? 0) >= 1
  }
  return true
}

/** Re-run the visibility policy over every unit on the picture. */
export function applyUnitVisibility(): void {
  const layer = getUnitLayer()
  if (!layer) return
  for (const u of Object.values(getAppState().units)) layer.upsert(u, unitMapVisible(u))
}

/** Master GPS tracking switch (roster header button). */
export function toggleGpsTracking(): void {
  setAppState((s) => ({ gpsTracking: !s.gpsTracking }))
  applyUnitVisibility()
}

/** Per-category visibility toggle (roster group headers). */
export function toggleUnitCategory(category: UnitCategory): void {
  const state = getAppState()
  const next = !state.unitToggles[category]
  setAppState((s) => ({ unitToggles: { ...s.unitToggles, [category]: next } }))
  applyUnitVisibility()
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
