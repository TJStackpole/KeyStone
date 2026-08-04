import * as Cesium from 'cesium'
import {
  fetchBuildingSafety,
  fetchCertificatesOfOccupancy,
  fetchFirehouses,
  fetchHydrants,
  fetchPluto,
  fetchRoadSegments,
  fetchStreetLabels,
  fetchTaxLots,
  fetchTrafficLinks,
  fetchTunnels,
  linksNear,
} from './api/nyc'
import { reverseGeocode } from './api/geosearch'
import { fetchWind } from './api/weather'
import { fetchFootprints, footprintContaining, sampleStreetBase, type Footprint } from './cesium/footprints'
import type { PoiKind } from './cesium/poi'
import { flyToTactical, OPS_AREA, TILE_CACHE_BYTES } from './cesium/providers'
import { exitGroundView, setGroundViewHeight, setTopDown } from './cesium/viewmode'
import {
  getBoundaryLayer,
  getDrawController,
  getFocusLayer,
  getFootprintLayer,
  getIntelLayer,
  getPortfolioLayer,
  getExposureLayer,
  getScene,
  getHazardLayer,
  getLotLayer,
  getPoiLayer,
  getRoadLayer,
  getShapeLayer,
  getStreetLayer,
  getTacticalLayer,
  getTrafficLayer,
  getTwinLayer,
  getUnitLayer,
} from './cesium/scene'
import { replayEngine } from './replay'
import { hasCapability } from './profiles/manifest'
import { crewCompositionAllowed } from './profiles/policy'
import { notify } from './components/NoticeChip'
import { applyOverlayLod, overlayLodAllows } from './cesium/overlayLod'
import { getAppState, setAppState, setLayerStatus } from './state/store'
import { crewOf } from './types'
import type {
  Agency,
  FeedIncident,
  GeoHit,
  IcsShape,
  Incident,
  IncidentType,
  ToggleLayerId,
  Unit,
  UnitCategory,
} from './types'

function newIncidentId(): string {
  return `INC-${Date.now().toString(36).toUpperCase()}`
}

/**
 * F1 bootstrap: address hit -> tactical fly-to, incident record, extruded
 * footprints with the target building highlighted, persistence to the server.
 */
export async function standUpIncident(hit: GeoHit, type: IncidentType = 'Structural Fire'): Promise<void> {
  // A new incident stood up by ANY path invalidates the previous box's CAD
  // packet — focusFeedIncident re-sets these right after when CAD-sourced.
  setAppState({ cadIncident: null, responsePacketOpen: false })
  clearShapeUndo()
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
  // exits restore controller settings, then the tactical flight wins. A
  // running replay of the OLD incident must end too, or its engine keeps
  // painting historical tracks over the new board.
  if (getAppState().replay.active) replayEngine.stop()
  // The accountability surfaces belong to ONE box: a new stand-up must not
  // inherit last box's ATTACK assignments or PAR stamps.
  setAppState({ parChecks: {}, boardAssignments: {} })
  try {
    localStorage.removeItem('ks-board')
  } catch {
    // storage blocked — the in-memory reset above still applies
  }
  resetIsolate()
  hideInspectedModel()
  lastFootprints = null
  setAppState({ footprintsGeo: null })
  getTrafficLayer()?.clear() // stale polylines from the previous location
  getHazardLayer()?.clear() // old site's wind arrow + collapse zones
  getUnitLayer()?.setInteriorBounds(null) // old footprint must not snap members
  if (getAppState().groundViewActive) exitGround()
  if (getAppState().viewMode === 'topdown' && scene) {
    setAppState({ viewMode: '3d' })
    void setTopDown(scene, false)
  }
  // Standing up an incident is a deliberate move to the tactical board —
  // the citywide chrome and its pick handlers must not linger on top.
  leaveWatchCommandSilently()
  if (scene) flyToTactical(scene.viewer, hit.lat, hit.lon)

  // These run concurrently; each degrades independently per the CLAUDE.md rule.
  void loadFootprints(incident)
  void loadSiteIntel(incident)
  lastPersist = persistIncident(incident)

  // ACTIVE INCIDENT focus: sharpen the fire building, de-emphasize >4 blocks.
  getFocusLayer()?.apply(incident, getAppState().activeIncidentMode)

  // Fresh incident, fresh overlay: clear local shapes (server-side list was
  // reset by the incident POST). Zones are drawn manually by the chief — no
  // auto-suggested perimeter. targetHeightM resets too — a stale height would
  // mis-size the collapse tool until the new footprints load.
  // The timeline reset also drops the OLD incident's sim.dispatched events —
  // otherwise the new building's schematic/floors panels inherit a stale fire
  // floor. stagingPick likewise: a reserved callsign from the old response.
  setAppState({
    shapes: {}, // (undo stack cleared below — entries reference this dead set)
    selectedShapeId: null,
    drawTool: null,
    targetHeightM: null,
    inspected: null,
    timeline: [],
    stagingPick: 'auto',
    isolateView: 'model', // a LIVE pick must not straddle incidents
    focusedFeedId: null, // manual stand-up — not tracking a feed entry
    wind: null, // refreshWind repaints for the new site
    floorRef: null, // loadFootprints republishes for the new target
  })
  getShapeLayer()?.clear()
}

/**
 * INCIDENTS dropdown: focus the board on one SIMULATED citywide feed entry —
 * full stand-up at its coordinates, then dispatch the assignment so the
 * responding units populate. One board at a time: focusing a feed incident
 * replaces whatever was up (same as standing up from search).
 */
export async function focusFeedIncident(fi: FeedIncident): Promise<void> {
  await standUpIncident(
    {
      label: `${fi.address}, ${fi.borough}`,
      name: fi.address,
      borough: fi.borough,
      lat: fi.lat,
      lon: fi.lon,
    },
    feedIncidentType(fi.type),
  )
  // The officer pressed THEIR box: assemble the response packet — dispatch
  // knowledge + building record + fire-so-far — and put the street view and
  // full SITREP up alongside, so the size-up starts before they arrive.
  setAppState({
    focusedFeedId: fi.id,
    cadIncident: fi,
    responsePacketOpen: true,
    streetViewOpen: true,
    utilityTab: 'sitrep',
  })
  // The feed reported units responding — put them on the picture.
  void dispatchAssignment()
}

/** Map a dispatch-feed type string onto the board's incident-type chips. */
function feedIncidentType(feedType: string): IncidentType {
  const t = feedType.toLowerCase()
  if (t.includes('fire')) return 'Structural Fire'
  if (t.includes('gas') || t.includes('package')) return 'Hazmat'
  if (t.includes('collapse')) return 'Collapse'
  if (t.includes('mva') || t.includes('medical') || t.includes('mci')) return 'Mass Casualty'
  return 'Structural Fire'
}

/**
 * Live address correction: the dispatch address is often wrong on real
 * incidents. A geocoded hit RELOCATES the incident (camera, footprints,
 * intel — shapes/units/timeline stay); free text corrects the label only.
 */
export async function editIncidentAddress(update: { label: string; hit?: GeoHit }): Promise<boolean> {
  const incident = getAppState().incident
  if (!incident) return false
  const patch: Partial<Incident> = { address: update.label }
  if (update.hit) {
    patch.lat = update.hit.lat
    patch.lon = update.hit.lon
    patch.bin = update.hit.bin
    patch.bbl = update.hit.bbl
    patch.borough = update.hit.borough
  }
  try {
    const res = await fetch('/api/incident', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) throw new Error(`address patch ${res.status}`)
  } catch (err) {
    console.error('[incident] address correction failed:', err)
    return false
  }
  // Functional merge onto CURRENT state — the incident may have changed
  // while the PATCH was in flight; a captured-snapshot write would resurrect
  // it. If it did change, the correction belongs to a dead board: skip.
  let applied: Incident | null = null
  setAppState((s) => {
    if (s.incident?.id !== incident.id) return {}
    applied = { ...s.incident, ...patch }
    return { incident: applied }
  })
  if (applied && update.hit) relocateIncidentSite(applied)
  return true
}

/**
 * The incident MOVED (address correction) — rebuild the site picture at the
 * new coordinates WITHOUT touching shapes, units, or the timeline. Used by
 * the local editor and by remote stations receiving the broadcast.
 */
export function relocateIncidentSite(incident: Incident): void {
  const scene = getScene()
  // A running replay owns the globe — its resyncLive() never re-runs the
  // footprint/intel loads, so relocating "under" it would strand the station
  // on the old site picture after replay exit.
  if (getAppState().replay.active) replayEngine.stop()
  resetIsolate()
  hideInspectedModel()
  lastFootprints = null
  setAppState({ footprintsGeo: null })
  getTrafficLayer()?.clear()
  getHazardLayer()?.clear()
  getUnitLayer()?.setInteriorBounds(null)
  setAppState({ targetHeightM: null, inspected: null, wind: null, floorRef: null, targetBounds: null })
  if (scene) flyToTactical(scene.viewer, incident.lat, incident.lon)
  void loadFootprints(incident)
  void loadSiteIntel(incident)
  getFocusLayer()?.apply(incident, getAppState().activeIncidentMode)
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
  // Prompt 14: the FETCH half is renderer-neutral — it must run (and publish
  // to the store for the 2D map) whether or not the 3D scene exists. Only
  // the render calls below are gated on the scene.
  const scene = getScene()
  const layer = getFootprintLayer()
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
    // Same geometry, renderer-neutral: the 2D tactical map draws from this.
    setAppState({ footprintsGeo: { feats, targetBin: targetBin ?? null } })
    if (scene && layer) void layer.render(feats, targetBin, scene.extrudeFootprints && !getAppState().isolateMode)
    // Remember the target's height — it drives the collapse-zone tool (1.5x rule).
    const target = feats.find((f) => f.bin === targetBin)
    setAppState({ targetHeightM: target?.heightM ?? null })
    // GPS accuracy: interior members snap into the fire building's real
    // footprint instead of drifting through walls.
    getUnitLayer()?.setInteriorBounds(target ? target.polygons.map((p) => p[0]).filter((r) => r && r.length >= 3) : null)
    // ...and position by FLOOR against true street level + storey height,
    // rather than trusting raw CoT altitude. Recomputed with the real PLUTO
    // floor count when it lands (loadSiteIntel).
    if (target) {
      // Structure frame for the battle views: the footprint's dominant edge
      // bearing (length-weighted, folded to the rectangle-symmetric
      // orientation via the 4θ trick) plus oriented half-extents. Facade
      // views aim along THESE axes — Manhattan's grid runs well off true
      // north, so world-axis views would stare at the building's corner.
      const rings = target.polygons.map((pg) => pg[0]).filter((r) => r && r.length >= 3)
      let frame: { centerLat: number; centerLon: number; bearingA: number; halfA: number; halfB: number } | null = null
      const pts = rings.flat()
      if (pts.length >= 3) {
        const cos0 = Math.cos((pts[0][1] * Math.PI) / 180)
        const toXY = ([lon, lat]: number[]) => [lon * 111_320 * cos0, lat * 111_320]
        let sx = 0
        let sy = 0
        for (const ring of rings) {
          for (let i = 0; i < ring.length; i++) {
            const [x1, y1] = toXY(ring[i])
            const [x2, y2] = toXY(ring[(i + 1) % ring.length])
            const dx = x2 - x1
            const dy = y2 - y1
            const len = Math.hypot(dx, dy)
            if (len < 0.5) continue
            const a4 = 4 * Math.atan2(dy, dx)
            sx += len * Math.cos(a4)
            sy += len * Math.sin(a4)
          }
        }
        const alpha = Math.atan2(sy, sx) / 4 // dominant edge direction (ENU)
        const ux = Math.cos(alpha)
        const uy = Math.sin(alpha)
        let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
        for (const pt of pts) {
          const [x, y] = toXY(pt)
          const u = x * ux + y * uy
          const v = -x * uy + y * ux
          if (u < minU) minU = u
          if (u > maxU) maxU = u
          if (v < minV) minV = v
          if (v > maxV) maxV = v
        }
        const cu = (minU + maxU) / 2
        const cv = (minV + maxV) / 2
        frame = {
          centerLat: (cu * uy + cv * ux) / 111_320,
          centerLon: (cu * ux - cv * uy) / (111_320 * cos0),
          bearingA: (((90 - (alpha * 180) / Math.PI) % 180) + 180) % 180,
          halfA: (maxU - minU) / 2,
          halfB: (maxV - minV) / 2,
        }
      }
      setAppState({ targetBounds: frame })
      void (async () => {
        const base = (await layer?.targetBase()) ?? 0
        const now = getAppState()
        if (now.incident?.id !== incident.id) return
        const floors = now.intel.pluto?.numFloors ?? Math.max(1, Math.round(target.heightM / 3.2))
        setAppState({ floorRef: { z0: base, storeyM: target.heightM / floors } })
        applyUnitVisibility()
      })()
    } else {
      setAppState({ floorRef: null, targetBounds: null })
    }
    // Module 4: per-face collapse zones from the real footprint + roof height.
    if (target && getAppState().layerToggles.collapsezones) {
      getHazardLayer()?.renderCollapse(target, target.heightM)
    }
    setLayerStatus('footprints', 'ok')
    // Self-heal ISOLATE: if the operator toggled it while footprints were in
    // flight, re-apply the clip against the freshly resolved target.
    if (getAppState().isolateMode) applyIsolate(true)
  } catch (err) {
    console.error('[footprints] layer unavailable:', err)
    if (getAppState().incident?.id !== incident.id) return
    lastFootprints = null
    setAppState({ footprintsGeo: null })
    resetIsolate() // a clip against vanished data is worse than no clip
    layer?.clear()
    getUnitLayer()?.setInteriorBounds(null)
    setAppState({ floorRef: null })
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
    notify('BUILDING FOOTPRINT STILL LOADING — try ISOLATE again in a moment')
    return
  }
  // ISOLATE owns the tactical layer — a tapped-building schematic in it
  // would be clobbered mid-session; clear it up front.
  if (on) hideInspectedModel()
  // Street-level camera and isolate framing don't mix — leave ground view
  // first so zoom/collision controller settings restore properly.
  if (on && getAppState().groundViewActive) exitGround()
  // Same for top-down: exit it so its saved camera restore point and (keyless)
  // Esri overlay don't linger under the isolate framing.
  if (on && getAppState().viewMode === 'topdown') {
    setAppState({ viewMode: '3d' })
    void setTopDown(scene, false)
  }
  setAppState({ isolateMode: on })
  applyIsolate(on, { frame: on })
}

if (import.meta.env.DEV) {
  // Debug handle: lets DevTools (and our own probes) see the isolate inputs.
  ;(window as unknown as Record<string, unknown>).__wtIsolate = {
    cache: () => lastFootprints,
    toggle: toggleIsolateMode,
  }
}

// Facility overlays parked during ISOLATE (with everything else).
const POI_KINDS: PoiKind[] = ['poiFirehouses', 'poiFdny', 'poiPrecincts', 'poiHospitals', 'poiNycem']

/**
 * ISOLATE is a single-building study — every background overlay (roads,
 * tunnels, street labels, traffic, lot lines, boundaries, facility POIs,
 * hydrant/firehouse marks, wind, collapse zones) auto-parks so the model is
 * the sole focus, and restores to its stored toggle on exit. Units and ICS
 * shapes stay — they ARE the operation. The stored toggles never change, so
 * the chips keep reflecting the operator's choices.
 */
function setOverlaysParked(parked: boolean): void {
  const t = getAppState().layerToggles
  const show = (on: boolean) => !parked && on
  getLotLayer()?.setVisible(show(t.lots) && overlayLodAllows('lots'))
  getRoadLayer()?.setRoadsVisible(show(t.roads) && overlayLodAllows('roads'))
  getRoadLayer()?.setTunnelsVisible(show(t.tunnels) && overlayLodAllows('tunnels'))
  getStreetLayer()?.setVisible(show(t.streets))
  getTrafficLayer()?.setVisible(show(t.traffic))
  getIntelLayer()?.setHydrantsVisible(show(t.hydrants))
  getIntelLayer()?.setFirehousesVisible(show(t.firehouses))
  getHazardLayer()?.setWindVisible(show(t.wind))
  getHazardLayer()?.setCollapseVisible(show(t.collapsezones))
  for (const kind of ['battalions', 'divisions'] as const) {
    getBoundaryLayer()
      ?.setVisible(kind, show(t[kind]))
      .catch(() => {}) // restore fetch failure — the toggle chip still reads true; next click retries
  }
  for (const kind of POI_KINDS) {
    getPoiLayer()
      ?.setEnabled(kind, show(t[kind]))
      .catch(() => {})
  }
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
      // Sharp but convergent: the clip hides everything outside the footprint
      // yet Cesium still STREAMS those tiles — at SSE 2 with foveation off the
      // whole (invisible) city refines at ultra detail and the building starves
      // in the request queue. SSE 4 + default foveation keeps the centered
      // building razor sharp while the periphery loads coarse.
      tileset.maximumScreenSpaceError = 4
      tileset.dynamicScreenSpaceError = false // no distance falloff for a lone target
      tileset.cacheBytes = 1024 * 1024 * 1024
    }
    // Render at native device pixels (Cesium defaults to CSS pixels — soft on
    // retina displays). Fine here: the clipped scene is one building.
    viewer.useBrowserRecommendedResolution = false
  } else {
    if (tileset) {
      tileset.foveatedScreenSpaceError = true // Cesium default
      tileset.dynamicScreenSpaceError = true // Cesium default (focus may re-tune below)
      // The app's own tuned cache size, not the Cesium default — restoring
      // 512 MB here silently shrank the tile cache for the rest of the session.
      tileset.cacheBytes = TILE_CACHE_BYTES
    }
    viewer.useBrowserRecommendedResolution = true
    // FocusLayer owns SSE outside isolate — reassert its current policy.
    const s = getAppState()
    getFocusLayer()?.apply(s.incident, s.activeIncidentMode)
  }
}

/**
 * Frame the isolated building at size-up distance, facade filling the view.
 * `base` is the PRE-CLIP street level — a fresh sample here would hit the
 * lifted building's roof (inside the footprint) or the re-shown globe.
 */
function frameIsolatedBuilding(base: number): void {
  const scene = getScene()
  const inc = getAppState().incident
  if (!scene || !inc) return
  const s = getAppState()
  // MODEL view stretches the schematic vertically — frame the scaled height.
  const k = s.isolateView === 'model' ? s.isolateScale : 1
  const h = (s.targetHeightM ?? 30) * k
  // The lift actually applied (0 in keyless — no tileset to translate).
  const lift = getAppState().isolateLiftM
  const target = lastFootprints?.feats.find((f) => f.bin === lastFootprints?.targetBin)
  // Horizontal extent from the bbox of EVERY part (fallback: a rowhouse).
  let extentM = 30
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
  for (const poly of target?.polygons ?? []) {
    for (const [lon, lat] of poly[0] ?? []) {
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon)
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
    }
  }
  if (Number.isFinite(minLon)) {
    extentM = Math.max(
      (maxLat - minLat) * 111_320,
      (maxLon - minLon) * 111_320 * Math.cos((inc.lat * Math.PI) / 180),
      15,
    )
  }
  const center = Cesium.Cartesian3.fromDegrees(inc.lon, inc.lat, base + lift + h / 2)
  const radius = Math.max(extentM / 2, h / 2) + 12
  scene.viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, radius), {
    offset: new Cesium.HeadingPitchRange(scene.viewer.camera.heading, Cesium.Math.toRadians(-18), radius * 3.4),
    duration: 1.4,
  })
}

let isolateApplySeq = 0
// True only once the ON continuation has actually mutated the scene — the
// MODEL/LIVE chips must not re-style a scene whose clip hasn't landed yet
// (hiding the tileset while the globe is still hidden blacks out the map).
let isolateApplied = false
// Pre-clip street level captured by the ON path — scale-chip reframes reuse
// it (a fresh sample would hit the isolate ground plane at the wrong height).
let lastIsolateBase = 0

/**
 * The ON path is async: it waits for the pre-clip street-level sample before
 * touching the scene, because mutating clip/lift/globe first would make the
 * still-pending ring samples resolve against the re-shown globe (~0 HAE)
 * instead of the sunken photorealistic streets (~-30 m) — floating box and
 * schematic. The OFF path stays synchronous (incident teardowns rely on it).
 */
function applyIsolate(on: boolean, opts: { frame?: boolean } = {}): void {
  const scene = getScene()
  if (!scene) return
  const seq = ++isolateApplySeq
  const tileset = scene.buildingTileset

  if (!on) {
    isolateApplied = false
    if (tileset) {
      tileset.clippingPolygons = new Cesium.ClippingPolygonCollection({ polygons: [] })
      tileset.modelMatrix = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY)
      tileset.show = true // MODEL view hides it — never leave the city hidden
      tileset.enableCollision = true // camera-vs-mesh guard back on
      if (scene.mode === 'google') scene.viewer.scene.globe.show = false
    }
    // isolateFloors clears BEFORE the unit pass — interior members must fall
    // back to their true CoT heights, not the torn-down schematic's floors.
    setAppState({ isolateLiftM: 0, isolateFloors: null })
    applyUnitVisibility()
    boostIsolateVisuals(false)
    // Keyless: bring the neighbor extrusions back.
    if (lastFootprints && scene.extrudeFootprints) {
      void getFootprintLayer()?.render(lastFootprints.feats, lastFootprints.targetBin, true)
    }
    getFootprintLayer()?.setTargetVisible(getAppState().layerToggles.targetbox)
    // Every background overlay was parked during isolate — restore each to
    // its stored toggle.
    setOverlaysParked(false)
    void applyTacticalModel(false)
    getTwinLayer()?.clear()
    return
  }

  void (async () => {
    const incId = getAppState().incident?.id
    const base = (await getFootprintLayer()?.targetBase()) ?? (scene.mode === 'google' ? -30 : 0)
    // Stale-guards: isolate may have toggled off, re-toggled, or the incident
    // may have changed while the sample was in flight.
    const s = getAppState()
    if (seq !== isolateApplySeq || !s.isolateMode || s.incident?.id !== incId) return
    if (!lastFootprints?.targetBin || lastFootprints.incidentId !== incId) return
    const target = lastFootprints.feats.find((f) => f.bin === lastFootprints?.targetBin)

    if (tileset && target) {
      const polygons = target.polygons.map(
        (poly) =>
          new Cesium.ClippingPolygon({
            positions: Cesium.Cartesian3.fromDegreesArray(poly[0].flat()),
          }),
      )
      if (polygons.length) {
        tileset.clippingPolygons = new Cesium.ClippingPolygonCollection({ polygons, inverse: true })
        // Mesh collision samples heights of CLIPPED-AWAY buildings too — it
        // would shove the camera over invisible towers. The globe + floor
        // clamp guard the flattened ground instead.
        tileset.enableCollision = false
        // Land the lone building ON the flattened ground: translate the
        // (fully clipped) tileset up by the depth of its sunken streets, so
        // the building's base sits at globe height — right where the
        // CLAMP_TO_GROUND unit markers are. Ground crews and the model read
        // as one picture instead of a levitating exhibit.
        const inc = s.incident
        if (inc) {
          const up = Cesium.Cartesian3.normalize(
            Cesium.Cartesian3.fromDegrees(inc.lon, inc.lat),
            new Cesium.Cartesian3(),
          )
          const liftM = -base + 0.5
          const lift = Cesium.Cartesian3.multiplyByScalar(up, liftM, new Cesium.Cartesian3())
          tileset.modelMatrix = Cesium.Matrix4.fromTranslation(lift)
          setAppState({ isolateLiftM: liftM }) // interior members ride the lift
        }
        // The globe is hidden in google mode (clamp correctness) — isolate
        // needs it back as the flattened-map ground under the lone building.
        scene.viewer.scene.globe.show = true
      }
    }
    // Re-place interior members at their (possibly lifted) heights.
    applyUnitVisibility()
    // Keyless: the neighbors are our own extrusions — just stop drawing them.
    if (scene.extrudeFootprints) {
      void getFootprintLayer()?.render(lastFootprints.feats, lastFootprints.targetBin, false)
    }
    // Sole focus: park EVERY background overlay for the isolate session —
    // the operator is studying one building, not the map.
    setOverlaysParked(true)
    // MODEL/LIVE appearance: tileset visibility, imagery boost, target-box
    // park, and the schematic itself all key off the selected view.
    isolateApplied = true
    lastIsolateBase = base // scale/view changes reframe against this
    applyIsolateAppearance()
    // The battle-view lock owns the camera when it is engaged — its own
    // facade flight (re-aimed when isolateFloors lands) replaces the generic
    // size-up framing.
    if (opts.frame && getAppState().viewLock === 'off') frameIsolatedBuilding(base)
  })()
}

/**
 * ISOLATE has two looks: MODEL (clean schematic replaces the building — the
 * clipped real mesh reads patchy up close) and LIVE (the real clipped
 * imagery with the wireframe over it). Applies tileset visibility, the
 * imagery boost, the street-box park, and rebuilds the schematic.
 */
function applyIsolateAppearance(): void {
  const scene = getScene()
  if (!scene) return
  const s = getAppState()
  const live = s.isolateView === 'live'
  if (scene.buildingTileset) scene.buildingTileset.show = !s.isolateMode || live
  // The ultra-detail boost only pays for itself when the real mesh is shown.
  boostIsolateVisuals(s.isolateMode && live)
  // Street-level orange box: parked while isolated except in keyless LIVE,
  // where the extruded box IS the building (chip keeps controlling it there).
  getFootprintLayer()?.setTargetVisible(
    s.isolateMode ? scene.extrudeFootprints && live && s.layerToggles.targetbox : s.layerToggles.targetbox,
  )
  void applyTacticalModel(s.isolateMode)
  // Blueprint digital twin (HABS/EIS-authored walls, windows, doors, stairs,
  // fire escapes): replaces the generic massing in MODEL view at true scale.
  // Vertical exaggeration would shear the drawn geometry — twin hides there.
  void (async () => {
    const twin = getTwinLayer()
    if (!twin) return
    const inc = getAppState().incident
    const wantTwin = s.isolateMode && s.isolateView === 'model' && s.isolateScale === 1 && !!inc
    if (!wantTwin) {
      twin.setVisible(false)
      return
    }
    const { fetchTwinForAddress } = await import('./cesium/twin')
    const def = await fetchTwinForAddress(inc!.address)
    const now = getAppState()
    if (!def || !now.isolateMode || now.isolateView !== 'model' || now.isolateScale !== 1 || now.incident?.id !== inc!.id) return
    await twin.load(def, now.isolateFloors?.z0 ?? 0)
    twin.setVisible(true)
    const st = getAppState()
    twin.setPlanFloor(st.viewLock === 'top' ? st.viewLockFloor : null)
    notify(`BLUEPRINT TWIN — ${def.name} (${def.source.split(',')[0]})`)
  })()
}

/** MODEL / LIVE sub-chips while ISOLATE is up. */
export function setIsolateView(view: 'model' | 'live'): void {
  if (getAppState().isolateView === view) return
  setAppState({ isolateView: view })
  // If the async ON path is still awaiting its pre-clip sample, just store
  // the choice — its own applyIsolateAppearance() picks it up when it lands.
  if (getAppState().isolateMode && isolateApplied) applyIsolateAppearance()
}

/**
 * MODEL-view vertical scale chips (1× / 1.5× / 2×): stretch the schematic so
 * floor-by-floor unit tracking reads at a glance, then reframe to fit.
 */
export function setIsolateScale(scale: number): void {
  if (getAppState().isolateScale === scale) return
  setAppState({ isolateScale: scale })
  if (getAppState().isolateMode && isolateApplied) {
    applyIsolateAppearance()
    // Locked views re-aim themselves off the rebuilt isolateFloors.
    if (getAppState().viewLock === 'off') frameIsolatedBuilding(lastIsolateBase)
  }
}

let tacticalSeq = 0

/**
 * Build (or clear) the ISOLATE tactical schematic wrapped on the isolated
 * building: a floor ring per storey, the fire floor flagged, and entrance /
 * estimated-egress marks. Floor data prefers the live dispatch, then PLUTO.
 */
async function applyTacticalModel(on: boolean): Promise<void> {
  const tactical = getTacticalLayer()
  if (!tactical) return
  const seq = ++tacticalSeq
  if (!on) {
    tactical.clear()
    return
  }
  const inc = getAppState().incident
  const target = lastFootprints?.feats.find((f) => f.bin === lastFootprints?.targetBin)
  if (!inc || !target) return
  // Street level was sampled pre-clip by the footprint render — reuse it; a
  // fresh sample now would hit the isolate ground plane at the wrong height.
  const base = (await getFootprintLayer()?.targetBase()) ?? 0
  const now = getAppState()
  if (seq !== tacticalSeq || !now.isolateMode || now.incident?.id !== inc.id) return
  let floors: number | undefined
  let fireFloor: number | undefined
  for (let i = now.timeline.length - 1; i >= 0; i--) {
    const ev = now.timeline[i]
    if (ev.kind === 'sim.dispatched') {
      const p = (ev.payload ?? {}) as { fireFloor?: number; floors?: number; incidentId?: string }
      // Belt-and-suspenders with the timeline resets: never let another
      // incident's dispatch paint a fabricated fire floor on this building.
      // Scenario-scripted dispatches can't know the runtime incident id —
      // only reject an EXPLICIT mismatch (another incident's dispatch).
      if (p.incidentId && p.incidentId !== inc.id) break
      floors = p.floors
      fireFloor = p.fireFloor
      break
    }
  }
  const heightM = now.targetHeightM ?? target.heightM
  floors = floors ?? now.intel.pluto?.numFloors ?? Math.max(1, Math.round(heightM / 3.2))
  // Vertical exaggeration is a MODEL-view affordance — the LIVE clipped mesh
  // can't stretch, so its schematic wireframe must stay true-scale over it.
  const scale = now.isolateView === 'model' ? now.isolateScale : 1
  tactical.show(target, {
    base,
    lift: now.isolateLiftM,
    heightM,
    floors,
    fireFloor,
    address: { lat: inc.lat, lon: inc.lon },
    view: now.isolateView,
    scale,
  })
  // Publish the schematic's floor geometry so interior members position by
  // FLOOR (mid-storey) — they stretch with the model instead of staying at
  // their true heights inside a taller shell.
  setAppState({ isolateFloors: { z0: base + now.isolateLiftM, storeyM: (heightM * scale) / floors, floors } })
  applyUnitVisibility()
}

/**
 * The provider upgrade (google/ion tileset) attaches in the BACKGROUND after
 * boot. Anything that sampled heights during the window resolved against the
 * still-visible globe (~0 HAE) instead of the sunken photorealistic streets —
 * re-bake it now: fresh footprint render (new pre-clip street sample), then
 * isolate on top of the corrected base.
 */
export function reconcileProviderUpgrade(): void {
  const scene = getScene()
  if (!scene) return
  setAppState({ providerMode: scene.mode })
  if (lastFootprints) {
    void getFootprintLayer()?.render(
      lastFootprints.feats,
      lastFootprints.targetBin,
      scene.extrudeFootprints && !getAppState().isolateMode,
    )
  }
  // Street labels baked against the keyless globe anchored at height 0 with
  // a "good" sample — the upgraded tileset's streets sit ~-30 m, leaving
  // those labels floating. Rebuild them against the new geometry.
  getStreetLayer()?.clear()
  void refreshStreetLabels(true)
  if (getAppState().isolateMode) applyIsolate(true)
}

/** Shared teardown: ACTIVE INCIDENT off, new incident, or END all clear isolate. */
export function resetIsolate(): void {
  if (!getAppState().isolateMode) return
  setAppState({ isolateMode: false })
  applyIsolate(false)
}

/**
 * The most recent incident POST — dispatch must SERIALIZE behind it. The
 * server dispatches to ITS current state.incident, so a /api/dispatch that
 * beats the /api/incident POST over the wire sends the assignment to the
 * PREVIOUS incident's coordinates.
 */
let lastPersist: Promise<void> = Promise.resolve()

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
    // A profile landing in Watch Command keeps its citywide frame — the
    // restored incident arrives as the focused portfolio marker instead
    // (same rule as adoption).
    if (scene && !getAppState().watchCommand) flyToTactical(scene.viewer, body.incident.lat, body.incident.lon)
    void loadFootprints(body.incident)
    void loadSiteIntel(body.incident)
    getFocusLayer()?.apply(body.incident, getAppState().activeIncidentMode)
  } catch {
    // Server not up yet — fine, the operator can still search.
  }
}

// ---------------------------------------------------------------------------
// Prompt 11 — NYCEM coordination layer (Watch Command, requests, weather,
// exercises). KeyStone is a neutral read-and-coordinate layer: these actions
// record and suggest; they never claim command authority for NYCEM.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Prompt 12 — workspace profile switch. Instant, preserves map position and
// the selected incident (both profiles have incident access), swaps chrome
// only. Logged to the event log now — it becomes the audit trail when real
// identity arrives.
// ---------------------------------------------------------------------------

export function setProfile(next: 'fdny' | 'nycem'): void {
  // FDNY loses the menu items for coordination POIs — persisted ON toggles
  // must not keep painting layers the workspace can no longer control.
  // Dashboard pages are FDNY chrome — a profile switch always lands on MAP.
  setAppState({ dashboardPage: 0 })
  if (next === 'fdny') {
    setAppState((s) => ({ layerToggles: { ...s.layerToggles, poiPrecincts: false, poiNycem: false } }))
    for (const kind of ['poiPrecincts', 'poiNycem'] as const) void getPoiLayer()?.setEnabled(kind, false).catch(() => {})
  }
  const prev = getAppState().profile
  if (next === prev) return
  localStorage.setItem('ks-profile', next)
  // Each window stays sovereign: with ?profile pinned in the URL, another
  // window's localStorage write can't flip this one on its next reload.
  if (new URLSearchParams(window.location.search).has('profile')) {
    const url = new URL(window.location.href)
    url.searchParams.set('profile', next)
    window.history.replaceState(null, '', url)
  }
  setAppState({ profile: next })
  applyUnitVisibility() // member markers are policy+profile gated
  if (next === 'nycem') {
    // Coordination posture: open the Watch Command chrome WITHOUT the
    // citywide camera flight — switching must preserve map position (the
    // flight belongs to landing/toggling, not to changing hats).
    openWatchCommandChrome()
  } else {
    // Tactical posture: NYCEM-only chrome must not linger. Camera stays put.
    leaveWatchCommandSilently()
  }
  void fetch('/api/timeline', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'profile_switch',
      payload: { from: prev, to: next, by: localStorage.getItem('ks-operator') ?? 'unnamed operator' },
    }),
  }).catch((err) => console.error('[profile] switch log failed:', err))
}

/** Watch Command panels + layers without moving the camera. */
function openWatchCommandChrome(): void {
  setAppState({ watchCommand: true })
  const now = getAppState()
  getPortfolioLayer()?.setIncidents(now.portfolio, now.portfolioHoverId)
  getPortfolioLayer()?.setWeather(now.weatherAlerts)
  getPortfolioLayer()?.setActive(true, (id) => focusPortfolioIncident(id))
}

/** NYC citywide framing for the Watch Command portfolio view. */
const WATCH_VIEW = { lon: -73.94, lat: 40.55, height: 62_000, pitchDeg: -55 }

export function enterWatchCommand(): void {
  const scene = getScene()
  if (!scene) return
  // Manifest guard: profiles without the Watch Command capability must never
  // enter this state — its panels, Escape handler, and exit chip are all
  // gated off, leaving an unrecoverable citywide half-state.
  if (!hasCapability(getAppState().profile, 'watchcommand.portfolio')) return
  if (getAppState().groundViewActive) exitGround()
  // Isolate clips every building but the incident out of the scene — the
  // citywide portfolio over a clipped-away city is unreadable. Unwind it
  // like the other special view modes.
  if (getAppState().isolateMode) toggleIsolateMode()
  if (getAppState().viewMode === 'topdown') {
    setAppState({ viewMode: '3d' })
    void setTopDown(scene, false)
  }
  openWatchCommandChrome()
  scene.viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(WATCH_VIEW.lon, WATCH_VIEW.lat, WATCH_VIEW.height),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(WATCH_VIEW.pitchDeg), roll: 0 },
    duration: 1.8,
  })
}

/**
 * Prompt 12 — the flagship two-screen pitch: this window becomes the FDNY
 * tactical display, a second window opens as NYCEM Watch Command, and the
 * server-side scenario engine drives both over the same ws clock (no sync
 * layer — one playback authority).
 */
export async function launchDualScreenDemo(): Promise<void> {
  if (getAppState().exerciseReviewDirty) {
    notify('UNSAVED AAR EDITS — save or discard the review before launching')
    return
  }
  const win = window.open(`${location.origin}${location.pathname}?profile=nycem`, 'keystone-nycem', 'width=1680,height=1050')
  if (!win) {
    // Do NOT start a one-screen "dual-screen demo": with no NYCEM window the
    // exercise would have no facilitator surface at all.
    notify('SECOND WINDOW BLOCKED — allow pop-ups for this site, then relaunch', 'red')
    return
  }
  setProfile('fdny')
  // exercise:true so the NYCEM window gets the ENDEX/AAR chrome; this
  // window's enterWatchCommand is a no-op under the FDNY profile.
  await loadScenario('pabt-flood-exercise', { exercise: true })
}

export function exitWatchCommand(): void {
  leaveWatchCommandSilently()
  // Breadcrumb behavior: return to the tactical board if one is up.
  const inc = getAppState().incident
  const scene = getScene()
  if (inc && scene) flyToTactical(scene.viewer, inc.lat, inc.lon)
}

/**
 * Drop the citywide chrome WITHOUT the breadcrumb flight — for tactical
 * actions (search-bar stand-up, feed pick, drill load) that fly the camera
 * themselves. Without this, those paths left the Watch Command panels,
 * markers, and pick handlers live on top of the tactical board.
 */
function leaveWatchCommandSilently(): void {
  if (!getAppState().watchCommand) return
  setAppState({ watchCommand: false, portfolioHoverId: null })
  getPortfolioLayer()?.setActive(false)
}

/**
 * Click-through from the citywide view: the portfolio and the tactical view
 * share the same incident objects — the board incident just exits to its
 * tactical view; a feed box focuses the board on it (existing flow); a
 * scripted secondary flies there WITHOUT killing the running drill (it is
 * tracked, not commanded — single tactical board at a time).
 */
export function focusPortfolioIncident(id: string): void {
  const pi = getAppState().portfolio.find((p) => p.id === id)
  if (!pi) return
  if (pi.focused) {
    exitWatchCommand()
    return
  }
  if (pi.source === 'feed') {
    const feed = getAppState().dispatchFeed.find((f) => f.id === id)
    if (feed) {
      leaveWatchCommandSilently()
      void focusFeedIncident(feed)
    }
    return
  }
  // Scenario secondary: fly the tactical camera to it, drill board intact.
  const scene = getScene()
  setAppState({ watchCommand: false, portfolioHoverId: null })
  getPortfolioLayer()?.setActive(false)
  if (scene) flyToTactical(scene.viewer, pi.lat, pi.lon)
}

/** Keep the citywide markers/weather in sync while Watch Command is up. */
export function refreshWatchLayers(): void {
  const s = getAppState()
  if (!s.watchCommand) return
  getPortfolioLayer()?.setIncidents(s.portfolio, s.portfolioHoverId)
  getPortfolioLayer()?.setWeather(s.weatherAlerts)
}

export async function changeEocLevel(level: 1 | 2 | 3 | 4, changedBy: string): Promise<boolean> {
  try {
    const res = await fetch('/api/nycem/eoc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level, changedBy }),
    })
    return res.ok
  } catch (err) {
    console.error('[nycem] eoc change failed:', err)
    return false
  }
}

/** Returns whether the decision was recorded — ACCEPT must not activate the
 *  plan when the logged decision itself failed (audit gap), or when another
 *  station already decided it (404 → duplicate activation). */
export async function decideSuggestion(
  id: string,
  action: 'accepted' | 'snoozed' | 'dismissed',
  by: string,
): Promise<boolean> {
  try {
    const res = await fetch(`/api/nycem/suggestions/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, by }),
    })
    return res.ok
  } catch (err) {
    console.error('[nycem] suggestion decision failed:', err)
    return false
  }
}

export async function activatePlanAction(plan: string, by: string): Promise<void> {
  try {
    await fetch('/api/nycem/plans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ plan, by }),
    })
  } catch (err) {
    console.error('[nycem] plan activation failed:', err)
  }
}

export async function saveRules(rules: import('./types').TriggerRule[]): Promise<boolean> {
  try {
    const res = await fetch('/api/nycem/rules', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules }),
    })
    return res.ok
  } catch {
    return false
  }
}

export async function requestTransition(id: string, state: string, by: string, reason?: string): Promise<void> {
  try {
    await fetch(`/api/requests/${encodeURIComponent(id)}/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, by, reason }),
    })
  } catch (err) {
    console.error('[requests] transition failed:', err)
  }
}

export async function openInteragencyRequest(input: {
  incidentId: string | null
  requestingAgency: string
  assignedAgency: string
  description: string
  priority: string
  createdBy: string
}): Promise<boolean> {
  try {
    const res = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    })
    return res.ok
  } catch {
    return false
  }
}

/** M8: end the running exercise — the server builds the HSEEP AAR draft. */
export async function finishExercise(): Promise<void> {
  try {
    const res = await fetch('/api/exercises/finish', { method: 'POST' })
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      console.error('[exercise] finish failed:', body?.error)
      return
    }
    const session = (await res.json()) as import('./types').ExerciseSession
    setAppState({ exerciseReview: session })
  } catch (err) {
    console.error('[exercise] finish failed:', err)
  }
}

/** ACTIVE INCIDENT chip: toggle the focus treatment on/off. */
export function toggleActiveIncidentMode(): void {
  const next = !getAppState().activeIncidentMode
  setAppState({ activeIncidentMode: next })
  getFocusLayer()?.apply(getAppState().incident, next)
  if (!next) resetIsolate() // ISOLATE rides on active-incident focus
}

/**
 * ACTIVE INCIDENT from a tapped address: the chip is enabled the moment the
 * operator clicks a building/address on the map — clicking it promotes the
 * inspected building to the active incident (full stand-up: camera,
 * footprints, intel, focus), which unlocks ISOLATE and MODEL/LIVE.
 */
export async function activateInspectedIncident(): Promise<void> {
  const s = getAppState()
  const hit = s.inspected?.hit
  if (!hit || s.incident) return
  // Focus treatment ON is the point of the button — a previously toggled-off
  // state must not stand up a dimmed, isolate-less incident.
  if (!s.activeIncidentMode) setAppState({ activeIncidentMode: true })
  await standUpIncident(hit)
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

  // Module 4: live wind rides every incident stand-up (keyless NWS).
  void refreshWind()

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
      // Seed the camera-follow gate: the fly-in's moveEnd otherwise refetches
      // the SAME labels (the gate only knew about camera-triggered fetches).
      streetSeq++
      lastStreetFetch = { lat: incident.lat, lon: incident.lon, radiusM: 500 }
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
      setAppState((s) => ({
        intel: { ...s.intel, pluto },
        // Sharpen the interior floor geometry with the REAL floor count —
        // the footprint pass estimated it from height alone.
        floorRef:
          s.floorRef && pluto?.numFloors && s.targetHeightM
            ? { z0: s.floorRef.z0, storeyM: s.targetHeightM / pluto.numFloors }
            : s.floorRef,
      }))
      applyUnitVisibility()
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
  // ISOLATE parks every background overlay — a chip flipped DURING isolate
  // must only update the stored toggle (restored on exit), never repaint the
  // sole-focus scene. The lots branch pioneered this; all overlays honor it.
  const parked = getAppState().isolateMode
  if (layer === 'footprints') getFootprintLayer()?.setVisible(next)
  if (layer === 'targetbox') {
    // While a LIFTED isolate (or the schematic MODEL view) is active the box
    // stays parked — it would sit under the levitated building as a detached
    // slab, or fight the schematic volume. Keyless LIVE isolate has no lift
    // and the box IS the building, so the chip keeps working there.
    const s = getAppState()
    getFootprintLayer()?.setTargetVisible(next && !(s.isolateMode && (s.isolateLiftM > 0 || s.isolateView === 'model')))
  }
  if (layer === 'hydrants') getIntelLayer()?.setHydrantsVisible(next && !parked)
  if (layer === 'firehouses') getIntelLayer()?.setFirehousesVisible(next && !parked)
  if (layer === 'streets') getStreetLayer()?.setVisible(next && !parked)
  if (layer === 'traffic') {
    getTrafficLayer()?.setVisible(next && !parked)
    if (next && !parked) void refreshTraffic()
  }
  if (layer === 'lots') {
    getLotLayer()?.setVisible(next && !parked && overlayLodAllows('lots'))
    if (next && !parked) {
      void refreshLots(true)
      if (!overlayLodAllows('lots')) notify('LOT LINES paint when you zoom closer')
    }
  }
  if (layer === 'roads') {
    getRoadLayer()?.setRoadsVisible(next && !parked && overlayLodAllows('roads'))
    if (next && !parked) {
      void refreshRoads(true)
      if (!overlayLodAllows('roads')) notify('ROAD NETWORK paints when you zoom closer')
    }
  }
  if (layer === 'wind') {
    getHazardLayer()?.setWindVisible(next && !parked)
    if (next && !parked) void refreshWind()
  }
  if (layer === 'collapsezones') {
    getHazardLayer()?.setCollapseVisible(next && !parked)
    if (next && !parked) {
      const target = lastFootprints?.feats.find((f) => f.bin === lastFootprints?.targetBin)
      if (target) getHazardLayer()?.renderCollapse(target, target.heightM)
    }
  }
  if (layer === 'tunnels') {
    getRoadLayer()?.setTunnelsVisible(next && !parked && overlayLodAllows('tunnels'))
    if (next && !parked) {
      ensureTunnels()
      if (!overlayLodAllows('tunnels')) notify('TUNNELS paint when you zoom closer')
    }
  }
  if (layer.startsWith('poi')) {
    // Citywide facility overlays (FacDB) — lazy-loaded on first enable. A
    // failed fetch reverts the checkbox so it never lies (and retries clean).
    // During isolate the fetch defers to exit (setOverlaysParked(false)).
    getPoiLayer()
      ?.setEnabled(layer as PoiKind, next && !parked)
      .catch((err) => {
        console.error(`[poi] ${layer} unavailable:`, err)
        setAppState((s) => ({ layerToggles: { ...s.layerToggles, [layer]: false } }))
      })
  }
  if (layer === 'battalions' || layer === 'divisions') {
    getBoundaryLayer()
      ?.setVisible(layer, next && !parked)
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
  setAppState({ cadIncident: null, responsePacketOpen: false }) // stale CAD packet dies with the old board
  clearShapeUndo()
  if (getAppState().replay.active) replayEngine.stop()
  resetIsolate()
  hideInspectedModel()
  lastFootprints = null
  setAppState({ footprintsGeo: null })
  getTrafficLayer()?.clear() // stale polylines from the previous location
  try {
    localStorage.removeItem('ks-board') // a drill must not inherit last box's board
  } catch {
    // storage blocked — the in-memory reset below still applies
  }
  setAppState({
    incident,
    parChecks: {}, // accountability surfaces belong to ONE box
    boardAssignments: {},
    shapes: {}, // (undo stack cleared below — entries reference this dead set)
    selectedShapeId: null,
    drawTool: null,
    targetHeightM: null,
    inspected: null,
    streetViewOpen: false,
    // The old incident's dispatch events must not feed the new building's
    // schematic/floors panels (a fabricated fire floor on a stakeholder demo).
    timeline: [],
    stagingPick: 'auto', // a reserved callsign from the old response is stale
    isolateView: 'model',
    wind: null,
    tacticsOverride: null,
    floorRef: null,
    focusedFeedId: null, // server-initiated board — not a feed pick
  })
  getUnitLayer()?.setInteriorBounds(null)
  getHazardLayer()?.clear()
  getShapeLayer()?.clear()
  const scene = getScene()
  if (getAppState().groundViewActive) exitGround()
  if (getAppState().viewMode === 'topdown' && scene) {
    setAppState({ viewMode: '3d' })
    void setTopDown(scene, false)
  }
  // Adoption is server-initiated (another station or a drill script stood
  // this up). An operator monitoring the citywide view keeps that view —
  // the incident arrives as the focused portfolio marker, not a camera yank
  // underneath the still-open Watch Command panels.
  if (scene && !getAppState().watchCommand) flyToTactical(scene.viewer, incident.lat, incident.lon)
  void loadFootprints(incident)
  void loadSiteIntel(incident)
  getFocusLayer()?.apply(incident, getAppState().activeIncidentMode)
}

// ---------------------------------------------------------------------------
// Scenario playback controls (Prompt 8A)
// ---------------------------------------------------------------------------

async function scenarioPost(path: string, body?: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch(`/api/scenario/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    if (!res.ok) throw new Error(`scenario ${path} ${res.status}`)
    return true
  } catch (err) {
    console.error('[scenario] control failed:', err)
    return false
  }
}

export async function loadScenario(name: string, opts: { exercise?: boolean } = {}): Promise<void> {
  // A plain drill is a tactical activity: drop the citywide chrome BEFORE the
  // load so the drill's incident broadcast flies the camera to the board.
  // (Deliberate operator action — restoring it on failure would flap the UI.)
  if (!opts.exercise) leaveWatchCommandSilently()
  // A failed load (bad name, server down) must not play whatever stale
  // scenario is loaded, open the exercise chrome over nothing, or apply the
  // comms-view mutations below — nothing about the request needs them first.
  if (!(await scenarioPost('load', { name, exercise: !!opts.exercise }))) return
  // Merged command view is the right default for multi-channel drill traffic.
  setAppState({ aarOpen: false, alert: null, commsAll: true, commsOpen: true })
  await scenarioPost('play')
  // Exercises are a Watch Command activity — open the portfolio view.
  if (opts.exercise) enterWatchCommand()
}

export const playScenario = (): Promise<boolean> => scenarioPost('play')
export const pauseScenario = (): Promise<boolean> => scenarioPost('pause')
export const setScenarioSpeed = (x: number): Promise<boolean> => scenarioPost('speed', { x })
export const jumpScenarioChapter = (id: string): Promise<boolean> => scenarioPost('chapter', { id })
/** Progress-bar scrub: seek to an arbitrary scenario second (fwd or back). */
export const seekScenario = (t: number): Promise<boolean> => scenarioPost('seek', { t })

export async function stopScenario(): Promise<void> {
  await scenarioPost('stop')
  getExposureLayer()?.clear()
  // Leave no scenario-only comms channel selected — its tab disappears.
  setAppState({ scenario: null, alert: null, aarOpen: false, commsChannel: 'fdny', commsAll: false })
}

/**
 * Cancel EVERYTHING — drill, demo dispatch, incident, shapes, units. One
 * escape hatch that always returns the platform to a clean searching state.
 */
export async function endIncident(): Promise<void> {
  // Mid-exercise, ending the incident tears down the exercise session
  // SERVER-WIDE (DELETE /api/incident runs scenario.stop()) — same rule as
  // the drill-bar ✕: only the facilitator workspace may end it.
  const s = getAppState()
  if (s.scenario?.exercise && !hasCapability(s.profile, 'aar.hseep-exercise')) {
    notify('LIVE EXERCISE — only the facilitator (NYCEM workspace) can end it')
    return
  }
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
  clearShapeUndo()
  // A running replay owns the globe and its EXIT control lives on the
  // incident UI — ending the incident must end the replay too.
  if (getAppState().replay.active) replayEngine.stop()
  resetIsolate()
  lastFootprints = null
  setAppState({ footprintsGeo: null })
  try {
    localStorage.removeItem('ks-board') // persisted board dies with the box
  } catch {
    // storage blocked — the in-memory reset below still applies
  }
  setAppState({
    incident: null,
    cadIncident: null,
    responsePacketOpen: false,
    // The accountability surfaces die with the incident — a stale PAR stamp
    // or last week's SEARCH assignment presented as current is a lie.
    parChecks: {},
    boardAssignments: {},
    shapes: {}, // (undo stack cleared below — entries reference this dead set)
    selectedShapeId: null,
    drawTool: null,
    targetHeightM: null,
    inspected: null,
    scenario: null,
    alert: null,
    aarOpen: false,
    streetViewOpen: false,
    commsChannel: 'fdny',
    commsAll: false,
    units: {},
    intel: { pluto: null, hydrants: [], firehouses: [], safety: null, cofo: [] },
    timeline: [],
    stagingPick: 'auto',
    wind: null,
    tacticsOpen: false,
    tacticsOverride: null,
    inspectedModelOn: false,
    floorRef: null,
    memberCrewToggles: {},
    focusedFeedId: null,
  })
  getUnitLayer()?.setInteriorBounds(null)
  getHazardLayer()?.clear()
  getShapeLayer()?.clear()
  getUnitLayer()?.clear()
  getFootprintLayer()?.clear()
  getIntelLayer()?.clear()
  getStreetLayer()?.clear()
  getExposureLayer()?.clear()
  getTrafficLayer()?.clear()
  getTacticalLayer()?.clear()
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

/** The establishing shot the app opens on — HOME falls back to it. */
const HOME_VIEW = { lon: -74.0085, lat: 40.6875, height: 2800, pitchDeg: -35 }

/**
 * HOME: fly back to YOUR CURRENT LOCATION — where the platform is physically
 * open — when the browser grants geolocation and the fix is inside the ops
 * envelope; otherwise the city-center establishing shot. The last good fix is
 * cached so repeat clicks fly instantly (and keep working through a flaky
 * GPS) while a fresh fix refreshes the cache in the background.
 */
let goHomeSeq = 0
let lastKnownHome: { lon: number; lat: number } | null = null

export function goHome(): void {
  const scene = getScene()
  if (!scene) return
  const seq = ++goHomeSeq
  if (getAppState().groundViewActive) exitGround()
  if (getAppState().viewMode === 'topdown') {
    // Leave top-down properly (Esri overlay + saved camera), but don't let its
    // restore flight run while we may be waiting on geolocation.
    setAppState({ viewMode: '3d' })
    void setTopDown(scene, false)
    scene.viewer.camera.cancelFlight()
  }
  const clickIncident = getAppState().incident?.id
  const fly = (lon: number, lat: number) => {
    // The geolocation callbacks can fire MINUTES later (the permission prompt
    // pauses the timeout clock) — never hijack a torn-down viewer, a newer
    // HOME click, or a board whose incident changed since the click.
    if (scene.viewer.isDestroyed() || getScene() !== scene) return
    if (seq !== goHomeSeq || getAppState().incident?.id !== clickIncident) return
    scene.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(lon, lat, HOME_VIEW.height),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(HOME_VIEW.pitchDeg), roll: 0 },
      duration: 1.8,
    })
  }
  if (!navigator.geolocation) {
    fly(HOME_VIEW.lon, HOME_VIEW.lat)
    return
  }
  const cached = lastKnownHome
  // Instant flight from the cached fix; the fresh fix below only refreshes
  // the cache (re-flying mid-flight for a few meters of drift would jar).
  if (cached) fly(cached.lon, cached.lat)
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const { latitude, longitude } = pos.coords
      const inside = Cesium.Rectangle.contains(OPS_AREA, Cesium.Cartographic.fromDegrees(longitude, latitude))
      if (inside) lastKnownHome = { lon: longitude, lat: latitude }
      if (!cached) fly(inside ? longitude : HOME_VIEW.lon, inside ? latitude : HOME_VIEW.lat)
    },
    () => {
      if (!cached) fly(HOME_VIEW.lon, HOME_VIEW.lat) // denied / unavailable / timed out
    },
    // 8 s: long enough to answer the permission prompt and for a cold GPS
    // fix — the old 2 s timeout expired first and HOME always fell back.
    { timeout: 8000, maximumAge: 300_000 },
  )
}

/** Fly back to the ACTIVE INCIDENT's tactical view (incident button). */
export function goToIncident(): void {
  const scene = getScene()
  const inc = getAppState().incident
  if (!scene || !inc) return
  if (getAppState().groundViewActive) exitGround()
  if (getAppState().viewMode === 'topdown') {
    setAppState({ viewMode: '3d' })
    void setTopDown(scene, false)
    scene.viewer.camera.cancelFlight()
  }
  flyToTactical(scene.viewer, inc.lat, inc.lon)
}

/** Compass click: swing the camera back to north, rotating about the view center. */
export function reorientNorth(): void {
  const scene = getScene()
  if (!scene) return
  const viewer = scene.viewer
  // Ground view: spin to north IN PLACE. The street camera sits below the
  // ellipsoid in google mode, where pickEllipsoid returns the ray's exit
  // point — flying to it would yank the operator out of ground view while
  // its controller settings (collision off, 2 m zoom floor) stay armed.
  if (getAppState().groundViewActive) {
    viewer.camera.setView({
      destination: viewer.camera.position.clone(),
      orientation: { heading: 0, pitch: viewer.camera.pitch, roll: 0 },
    })
    return
  }
  const canvas = viewer.scene.canvas
  const belowEllipsoid = viewer.camera.positionCartographic.height < 0
  const center = belowEllipsoid
    ? undefined
    : viewer.camera.pickEllipsoid(
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

// ---------------------------------------------------------------------------
// Tax-lot borders: DOF Digital Tax Map polygons fetched around the CAMERA
// whenever it sits low enough to read parcels — every lot in the city is
// reachable by just panning there. Clicks resolve against these borders.
// ---------------------------------------------------------------------------

const LOT_MAX_CAMERA_M = 4500
const ROAD_MAX_CAMERA_M = 6000
let lotSeq = 0
let lastLotFetch: { lat: number; lon: number; radiusM: number } | null = null

/**
 * Where the operator is LOOKING (screen-center ellipsoid pick), clamped along
 * its bearing so horizon-grazing pitches don't put the fetch center
 * kilometers out. Falls back to the camera's ground foot.
 */
function lookAtCenter(): { lat: number; lon: number; heightM: number } | null {
  const scene = getScene()
  if (!scene) return null
  const viewer = scene.viewer
  const cam = viewer.camera.positionCartographic
  const footLat = Cesium.Math.toDegrees(cam.latitude)
  const footLon = Cesium.Math.toDegrees(cam.longitude)
  let lat = footLat
  let lon = footLon
  if (cam.height > 0) {
    const canvas = viewer.scene.canvas
    const center = viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
      viewer.scene.globe.ellipsoid,
    )
    if (center) {
      const c = Cesium.Cartographic.fromCartesian(center)
      const pLat = Cesium.Math.toDegrees(c.latitude)
      const pLon = Cesium.Math.toDegrees(c.longitude)
      const maxM = Math.min(Math.max(cam.height * 3, 800), 2500)
      const dLatM = (pLat - footLat) * 111_320
      const dLonM = (pLon - footLon) * 111_320 * Math.cos((footLat * Math.PI) / 180)
      const dist = Math.hypot(dLatM, dLonM)
      const k = dist > maxM ? maxM / dist : 1
      lat = footLat + (pLat - footLat) * k
      lon = footLon + (pLon - footLon) * k
    }
  }
  return { lat, lon, heightM: cam.height }
}

/** Small-nudge suppression shared by the camera-following layers. */
function movedEnough(
  last: { lat: number; lon: number; radiusM: number } | null,
  lat: number,
  lon: number,
  radiusM: number,
): boolean {
  if (!last) return true
  const moved = Math.hypot((lat - last.lat) * 111_320, (lon - last.lon) * 85_000)
  return moved >= last.radiusM * 0.35 || radiusM > last.radiusM * 1.3
}

let lotAbort: AbortController | null = null

export async function refreshLots(force = false): Promise<void> {
  const layer = getLotLayer()
  if (!layer || !getAppState().layerToggles.lots) return
  // ISOLATE studies ONE building — ground-classified lot lines would paint
  // cyan borders up the levitated facade (facades sit exactly on lot lines).
  if (getAppState().isolateMode) return
  const center = lookAtCenter()
  if (!center || center.heightM > LOT_MAX_CAMERA_M) return // parcel lines are street-scale detail
  const { lat, lon } = center
  const radiusM = Math.min(900, Math.max(300, center.heightM * 0.7))
  if (!force && !movedEnough(lastLotFetch, lat, lon, radiusM)) return
  const seq = ++lotSeq
  // One in-flight fetch at a time; the movement gate is written OPTIMISTICALLY
  // (rolled back on failure/empty) so a settle DURING a fetch can't duplicate
  // a several-hundred-KB download that always completes.
  lotAbort?.abort()
  lotAbort = new AbortController()
  const prevGate = lastLotFetch
  lastLotFetch = { lat, lon, radiusM }
  try {
    const lots = await fetchTaxLots(lat, lon, radiusM, lotAbort.signal)
    if (seq !== lotSeq || !getAppState().layerToggles.lots) return
    if (layer !== getLotLayer()) return // scene torn down/remounted mid-fetch
    // Empty results keep the old grid (render no-ops) — and must not poison
    // the movement gate, or the next pan would never refetch.
    if (!lots.length) {
      lastLotFetch = prevGate
      return
    }
    layer.render(lots)
  } catch (err) {
    if (seq === lotSeq) lastLotFetch = prevGate
    if ((err as Error).name === 'AbortError') return // superseded, not broken
    console.error('[lots] layer unavailable:', err) // degrade, never crash
  }
}

// ---------------------------------------------------------------------------
// Road network + tunnels (OVERLAYS): yellow centerline overlay following the
// camera, plus the four major vehicular tunnels loaded once citywide.
// ---------------------------------------------------------------------------

let roadSeq = 0
let lastRoadFetch: { lat: number; lon: number; radiusM: number } | null = null

let roadAbort: AbortController | null = null

export async function refreshRoads(force = false): Promise<void> {
  const layer = getRoadLayer()
  if (!layer || !getAppState().layerToggles.roads) return
  if (getAppState().isolateMode) return // parked — sole-focus building study
  const center = lookAtCenter()
  if (!center || center.heightM > ROAD_MAX_CAMERA_M) return
  const { lat, lon } = center
  const radiusM = Math.min(1200, Math.max(400, center.heightM * 0.8))
  if (!force && !movedEnough(lastRoadFetch, lat, lon, radiusM)) return
  const seq = ++roadSeq
  roadAbort?.abort()
  roadAbort = new AbortController()
  const prevGate = lastRoadFetch
  lastRoadFetch = { lat, lon, radiusM } // optimistic — rolled back on fail/empty
  try {
    const segments = await fetchRoadSegments(lat, lon, radiusM, roadAbort.signal)
    if (seq !== roadSeq || !getAppState().layerToggles.roads) return
    if (layer !== getRoadLayer()) return // scene torn down/remounted mid-fetch
    if (!segments.length) {
      lastRoadFetch = prevGate
      return
    }
    layer.renderRoads(segments)
  } catch (err) {
    if (seq === roadSeq) lastRoadFetch = prevGate
    if ((err as Error).name === 'AbortError') return
    console.error('[roads] layer unavailable:', err)
  }
}

let tunnelsLoaded = false
let tunnelsLoading = false

export function ensureTunnels(): void {
  const layer = getRoadLayer()
  if (!layer || tunnelsLoaded || tunnelsLoading || !getAppState().layerToggles.tunnels) return
  tunnelsLoading = true
  fetchTunnels()
    .then((segments) => {
      if (layer !== getRoadLayer()) return // scene torn down/remounted mid-fetch
      tunnelsLoaded = true
      layer.renderTunnels(segments)
      applyOverlayLod()
    })
    .catch((err) => {
      console.error('[tunnels] layer unavailable:', err)
      setAppState((s) => ({ layerToggles: { ...s.layerToggles, tunnels: false } }))
    })
    .finally(() => {
      tunnelsLoading = false
    })
}

// Street labels now FOLLOW the camera (not just the incident) so every street
// in view is named when zoomed to a readable range.
let streetSeq = 0
let lastStreetFetch: { lat: number; lon: number; radiusM: number } | null = null
/** Last successful fetch — height-only retries rebuild from this, fetch-free. */
let lastStreetLabels: Awaited<ReturnType<typeof fetchStreetLabels>> | null = null

let streetAbort: AbortController | null = null

export async function refreshStreetLabels(force = false): Promise<void> {
  const layer = getStreetLayer()
  if (!layer || !getAppState().layerToggles.streets) return
  if (getAppState().isolateMode) return // parked — sole-focus building study
  const center = lookAtCenter()
  if (!center || center.heightM > ROAD_MAX_CAMERA_M) return
  const { lat, lon } = center
  const radiusM = Math.min(1000, Math.max(400, center.heightM * 0.8))
  if (!force && !movedEnough(lastStreetFetch, lat, lon, radiusM)) {
    // Labels painted mid-fly-in fall back to height 0 (destination tiles not
    // rendered yet) — retry from the CACHED fetch until set() can sample real
    // heights or each label exhausts its attempt cap. No Socrata traffic:
    // an off-frustum label that never samples must not refetch on every
    // moveEnd for the rest of the session.
    if (layer.needsHeightRetry() && lastStreetLabels) layer.set(lastStreetLabels)
    return
  }
  const seq = ++streetSeq
  streetAbort?.abort()
  streetAbort = new AbortController()
  const prevGate = lastStreetFetch
  lastStreetFetch = { lat, lon, radiusM } // optimistic — rolled back on fail/empty
  try {
    const streets = await fetchStreetLabels(lat, lon, radiusM, streetAbort.signal)
    if (seq !== streetSeq || !getAppState().layerToggles.streets) return
    if (layer !== getStreetLayer()) return // scene torn down/remounted mid-fetch
    if (!streets.length) {
      lastStreetFetch = prevGate
      return
    }
    lastStreetLabels = streets
    layer.set(streets)
  } catch (err) {
    if (seq === streetSeq) lastStreetFetch = prevGate
    if ((err as Error).name === 'AbortError') return
    console.error('[streets] labels unavailable:', err)
  }
}

let inspectSeq = 0
let inspectAbort: AbortController | null = null

export async function inspectBuildingAt(lat: number, lon: number): Promise<void> {
  const seq = ++inspectSeq
  // Rapid taps used to stack dozens of stale in-flight SODA/geosearch
  // requests (each click fans out several) — cancel the previous fan-out.
  inspectAbort?.abort()
  inspectAbort = new AbortController()
  const signal = inspectAbort.signal
  // The tax lot UNDER the click is authoritative for the address — the
  // nearest address POINT can belong to the neighbor when a click lands
  // mid-lot (yard, parking, big footprint).
  const lotBbl = getLotLayer()?.lotAt(lon, lat) ?? null
  let hit: GeoHit | null = null
  try {
    hit = await reverseGeocode(lat, lon, signal)
  } catch (err) {
    if ((err as Error).name === 'AbortError') return
    console.error('[inspect] reverse geocode unavailable:', err)
  }
  if (seq !== inspectSeq) return
  if (lotBbl && hit?.bbl !== lotBbl) {
    const lotPluto = await fetchPluto(lotBbl, signal).catch(() => null)
    if (seq !== inspectSeq) return
    if (lotPluto?.address) {
      const borough = hit?.borough ?? 'New York'
      hit = {
        label: `${lotPluto.address}, ${borough}`,
        name: lotPluto.address,
        borough,
        lat,
        lon,
        bbl: lotBbl,
        // No BIN: the click identified a LOT; BIN-scoped intel stays empty.
        bin: undefined,
      }
    }
  }
  if (!hit) return
  const incident = getAppState().incident
  // Tapping the incident building itself just returns the panel to it.
  if (incident?.bin && hit.bin && incident.bin === hit.bin) {
    hideInspectedModel()
    setAppState({ inspected: null })
    return
  }
  // A schematic of the PREVIOUS tapped building must not linger under the
  // new building's panel.
  hideInspectedModel()
  // The tapped address also lands in the search bar — one Enter away from
  // standing up a new incident there.
  setAppState({
    inspected: { hit, loading: true, pluto: null, safety: null, cofo: [] },
    searchPrefill: hit.label,
  })
  const [pluto, safety, cofo] = await Promise.all([
    hit.bbl ? fetchPluto(hit.bbl, signal).catch(() => null) : Promise.resolve(null),
    hit.bin ? fetchBuildingSafety(hit.bin, signal).catch(() => null) : Promise.resolve(null),
    hit.bin ? fetchCertificatesOfOccupancy(hit.bin, signal).catch(() => []) : Promise.resolve([]),
  ])
  if (seq !== inspectSeq) return
  const current = getAppState().inspected
  if (!current || current.hit !== hit) return
  setAppState({ inspected: { hit, loading: false, pluto, safety, cofo } })
}

export function clearInspected(): void {
  inspectSeq++
  hideInspectedModel()
  setAppState({ inspected: null })
}

let inspectedModelSeq = 0

/**
 * Tapped-building 3D schematic — NO incident required. Fetches the real
 * footprint under the inspected address, samples true street level, and
 * wraps the same tactical schematic on it (floors from PLUTO, no fire
 * floor), then frames it. ISOLATE owns the tactical layer while it's up,
 * so this is unavailable during isolate (the button hides too).
 */
export async function showInspectedModel(): Promise<void> {
  const scene = getScene()
  const tactical = getTacticalLayer()
  const ins = getAppState().inspected
  if (!scene || !tactical || !ins || getAppState().isolateMode) return
  const seq = ++inspectedModelSeq
  const { hit } = ins
  try {
    const feats = await fetchFootprints(hit.lat, hit.lon, 120)
    // BIN match first, then point-in-polygon, then nearest centroid — PAD
    // address points often sit on the sidewalk outside every ring.
    let target =
      (hit.bin ? feats.find((f) => f.bin === hit.bin) : undefined) ??
      footprintContaining(hit.lon, hit.lat, feats)
    if (!target) {
      let bestD2 = Infinity
      const cosLat = Math.cos((hit.lat * Math.PI) / 180)
      for (const f of feats) {
        const outer = f.polygons[0]?.[0]
        if (!outer?.length) continue
        let cLon = 0, cLat = 0
        for (const [lon, lat] of outer) { cLon += lon; cLat += lat }
        cLon /= outer.length
        cLat /= outer.length
        const d2 = ((cLon - hit.lon) * cosLat) ** 2 + (cLat - hit.lat) ** 2
        if (d2 < bestD2) { bestD2 = d2; target = f }
      }
      // Nearest-centroid rescue only within ~60 m — beyond that it's a guess.
      if (Math.sqrt(bestD2) * 111_320 > 60) target = undefined
    }
    if (!target) throw new Error('no footprint under the address')
    const base = await sampleStreetBase(scene.viewer.scene, target)
    const now = getAppState()
    if (seq !== inspectedModelSeq || now.inspected?.hit !== hit || now.isolateMode) return
    const heightM = target.heightM
    const floors = now.inspected.pluto?.numFloors ?? Math.max(1, Math.round(heightM / 3.2))
    tactical.show(target, {
      base,
      lift: 0,
      heightM,
      floors,
      address: { lat: hit.lat, lon: hit.lon },
      view: 'model',
      scale: 1,
    })
    setAppState({ inspectedModelOn: true })
    // Frame it — bbox center (the hit point is on the sidewalk).
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
    for (const poly of target.polygons) {
      for (const [lon, lat] of poly[0] ?? []) {
        minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon)
        minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
      }
    }
    const extentM = Math.max(
      (maxLat - minLat) * 111_320,
      (maxLon - minLon) * 111_320 * Math.cos((hit.lat * Math.PI) / 180),
      15,
    )
    const center = Cesium.Cartesian3.fromDegrees(
      (minLon + maxLon) / 2,
      (minLat + maxLat) / 2,
      base + heightM / 2,
    )
    const radius = Math.max(extentM / 2, heightM / 2) + 12
    scene.viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(center, radius), {
      offset: new Cesium.HeadingPitchRange(scene.viewer.camera.heading, Cesium.Math.toRadians(-18), radius * 3.4),
      duration: 1.4,
    })
  } catch (err) {
    console.error('[inspect] 3D model unavailable:', err)
  }
}

/** Clear the tapped-building schematic (never touches an ISOLATE schematic). */
export function hideInspectedModel(): void {
  inspectedModelSeq++
  if (getAppState().inspectedModelOn) {
    getTacticalLayer()?.clear()
    setAppState({ inspectedModelOn: false })
  }
}

// ---------------------------------------------------------------------------
// Live traffic (DOT Traffic Speeds NBE): refreshed every 60 s while the
// TRAFFIC layer is on and an incident exists. The interval is a permanent
// low-cost heartbeat — the gate conditions do the work.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Module 4: live NWS wind at the incident (api.weather.gov — free, keyless).
// ---------------------------------------------------------------------------

let windTimer: ReturnType<typeof setInterval> | null = null
let windSeq = 0

export async function refreshWind(): Promise<void> {
  const { incident, layerToggles } = getAppState()
  if (!incident) return
  if (!windTimer) {
    windTimer = setInterval(() => void refreshWind(), 10 * 60_000)
  }
  const seq = ++windSeq
  try {
    const wind = await fetchWind(incident.lat, incident.lon)
    if (seq !== windSeq || getAppState().incident?.id !== incident.id) return
    setAppState({ wind })
    if (wind) {
      getHazardLayer()?.renderWind(incident.lat, incident.lon, wind, incident.type === 'Hazmat')
      getHazardLayer()?.setWindVisible(layerToggles.wind)
    }
  } catch (err) {
    console.error('[wind] NWS unavailable:', err) // degrade, never crash
  }
}

let trafficTimer: ReturnType<typeof setInterval> | null = null

export async function refreshTraffic(): Promise<void> {
  const { incident, layerToggles } = getAppState()
  if (!incident || !layerToggles.traffic) return
  if (!trafficTimer) {
    trafficTimer = setInterval(() => void refreshTraffic(), 60_000)
  }
  try {
    // ONE citywide download per cycle; the 2500 m try and the 8000 m widen
    // (DOT sensors cover highways/arterials only — residential incidents need
    // the approach corridors) both filter the same in-memory array.
    const all = await fetchTrafficLinks()
    let links = linksNear(all, incident.lat, incident.lon, 2500)
    if (!links.length) links = linksNear(all, incident.lat, incident.lon, 8000)
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

/**
 * Mayday camera snap. Prefer the coordinates CAPTURED WITH THE ALERT — during
 * a replay the units store is frozen at replay-start, so flying to the store
 * position would aim at empty map while highlighting a historical marker.
 */
export function flyToAlert(alert: { uid?: string; lat?: number; lon?: number }): void {
  if (typeof alert.lat === 'number' && typeof alert.lon === 'number') {
    if (alert.uid && !getAppState().replay.active) getUnitLayer()?.showLabel(alert.uid)
    flyToFeature(alert.lat, alert.lon)
    return
  }
  if (alert.uid && !getAppState().replay.active) flyToUnit(alert.uid)
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
    // Per-crew switch: the roster can hide one company's members while the
    // rest of the picture stays up. Missing key = shown.
    if (s.memberCrewToggles[crewOf(u.callsign)] === false) return false
    // Visibility policy: under aggregate-only PAR a coordinating profile
    // must not see member-level markers on the map either — the roster
    // hides the rows while the globe would leak the same callsign+floor.
    if (!crewCompositionAllowed(s.profile, s.visibilityPolicy)) return false
    return u.category === 'ff' && (u.floor ?? 0) >= 1
  }
  return true
}

/** Roster crew rows: show/hide ONE company's individual members on the map. */
export function toggleMemberCrew(crew: string): void {
  setAppState((s) => ({
    memberCrewToggles: { ...s.memberCrewToggles, [crew]: s.memberCrewToggles[crew] === false },
  }))
  applyUnitVisibility()
}

/** Re-run the visibility policy over every unit on the picture. */
export function applyUnitVisibility(): void {
  // During REPLAY the globe shows historical positions — injecting live unit
  // state would corrupt the playback. Instead, rebuild the CURRENT historical
  // picture so the GPS/category/agency toggles keep working mid-replay.
  if (getAppState().replay.active) {
    replayEngine.reapplyVisibility()
    return
  }
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

// Undo stack for operator shape actions (place / edit / delete / clear-all).
// Entries reverse through the SILENT internals so an undo never records a
// new undo. Multi-user semantics stay last-write-wins, same as every other
// shape write. Cleared whenever the incident's shape set is torn down.
interface ShapeUndoEntry {
  label: string
  apply: () => Promise<void>
}
const undoStack: ShapeUndoEntry[] = []
const UNDO_MAX = 50

function pushShapeUndo(entry: ShapeUndoEntry): void {
  undoStack.push(entry)
  if (undoStack.length > UNDO_MAX) undoStack.shift()
  setAppState({ undoDepth: undoStack.length, undoLabel: entry.label })
}

export function clearShapeUndo(): void {
  undoStack.length = 0
  setAppState({ undoDepth: 0, undoLabel: null })
}

export async function undoShapeAction(): Promise<void> {
  if (getAppState().replay.active) return
  const entry = undoStack.pop()
  setAppState({ undoDepth: undoStack.length, undoLabel: undoStack[undoStack.length - 1]?.label ?? null })
  if (entry) await entry.apply()
}

/** Silent write: optimistic apply + PUT, no undo recording. */
async function persistShape(shape: IcsShape): Promise<void> {
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

/** Silent delete: optimistic apply + DELETE, no undo recording. */
async function removeShapeSilent(id: string): Promise<void> {
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

/** Drag-end save: the undo entry restores the PRE-drag shape captured when
 *  the drag started — recording the post-drag state would make undo a no-op. */
export async function saveShapeWithPrior(shape: IcsShape, prior: IcsShape | null): Promise<void> {
  if (getAppState().replay.active) return
  pushShapeUndo(
    prior
      ? { label: `${prior.kind} edit`, apply: () => persistShape(prior) }
      : { label: `${shape.kind} placement`, apply: () => removeShapeSilent(shape.id) },
  )
  await persistShape(shape)
}

/** Persist + broadcast + CoT-publish one shape (create or vertex edit). */
export async function saveShape(shape: IcsShape): Promise<void> {
  if (getAppState().replay.active) return // the replayed picture is history, not a draft
  const prior = getAppState().shapes[shape.id]
  pushShapeUndo(
    prior
      ? { label: `${prior.kind} edit`, apply: () => persistShape(prior) }
      : { label: `${shape.kind} placement`, apply: () => removeShapeSilent(shape.id) },
  )
  await persistShape(shape)
}

export async function deleteShape(id: string): Promise<void> {
  if (getAppState().replay.active) return
  const prior = getAppState().shapes[id]
  if (prior) pushShapeUndo({ label: `${prior.kind} delete`, apply: () => persistShape(prior) })
  await removeShapeSilent(id)
}

/**
 * CLR ALL under the draw tools: wipe every placed shape — perimeter, posts,
 * staging pads, collapse zones, measurements — in one press (two-press
 * confirm lives in the toolbar). Optimistic local wipe, then server deletes
 * so every other dashboard's board clears too.
 */
export async function clearAllShapes(): Promise<void> {
  if (getAppState().replay.active) return // never bulk-delete the historical picture
  const prior = Object.values(getAppState().shapes)
  if (!prior.length) return
  pushShapeUndo({
    label: `clear all (${prior.length})`,
    apply: async () => {
      await Promise.allSettled(prior.map((s) => persistShape(s)))
    },
  })
  setAppState({ shapes: {}, selectedShapeId: null, drawTool: null })
  getShapeLayer()?.clear()
  // Half-drawn drafts and the selected shape's vertex handles live in the
  // DrawController's own sources — clear them too or they orphan on screen.
  getDrawController()?.cancelDraft()
  getDrawController()?.renderHandles()
  const results = await Promise.allSettled(
    prior.map((s) => fetch(`/api/shapes/${encodeURIComponent(s.id)}`, { method: 'DELETE' })),
  )
  // HTTP-level failures count too (a 5xx is a fulfilled fetch); 404 means
  // the shape was already gone — that IS success for a delete.
  const failed = results.filter(
    (r) => r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.ok && r.value.status !== 404),
  ).length
  if (failed) notify(`CLEAR ALL: ${failed} shape${failed === 1 ? '' : 's'} failed to delete on the server`, 'red')
}

/**
 * One-press EXPOSURES: label the fire building's four sides the way FDNY
 * talks about them — Exposure 1 is the address/street side, then 2-3-4
 * clockwise. Markers sit just off each facade midpoint using the structure
 * frame, so they are right even on Manhattan's rotated grid.
 */
export async function placeExposureLabels(): Promise<void> {
  if (getAppState().replay.active) return // history is not a drafting surface
  const s = getAppState()
  const b = s.targetBounds
  const inc = s.incident
  if (!b || !inc) {
    notify('EXPOSURES needs the fire building loaded first')
    return
  }
  const angDist = (x: number, y: number) => Math.abs((((x - y) % 360) + 540) % 360 - 180)
  const toXY = (latM: number) => 111_320 * Math.cos((b.centerLat * Math.PI) / 180) * latM
  void toXY
  // Bearing from footprint center to the address point = the street side.
  const dLatM = (inc.lat - b.centerLat) * 111_320
  const dLonM = (inc.lon - b.centerLon) * 111_320 * Math.cos((b.centerLat * Math.PI) / 180)
  const toward = (Math.atan2(dLonM, dLatM) * 180) / Math.PI
  const normals = [0, 1, 2, 3].map((i) => (((b.bearingA + i * 90) % 360) + 360) % 360)
  let front = normals[0]
  for (const n of normals) if (angDist(n, toward) < angDist(front, toward)) front = n
  const placed: IcsShape[] = []
  for (let e = 0; e < 4; e++) {
    const bearing = (front + e * 90) % 360
    const alongA = angDist(bearing, b.bearingA) < 45 || angDist(bearing, (b.bearingA + 180) % 360) < 45
    const standoff = (alongA ? b.halfA : b.halfB) + 10
    const rad = (bearing * Math.PI) / 180
    const lat = b.centerLat + (standoff * Math.cos(rad)) / 111_320
    const lon = b.centerLon + (standoff * Math.sin(rad)) / (111_320 * Math.cos((b.centerLat * Math.PI) / 180))
    placed.push({
      id: `WT-ICS-POST-EXP${e + 1}-${Date.now().toString(36).toUpperCase()}`,
      kind: 'post',
      post: 'exposure',
      lat,
      lon,
      label: `EXP ${e + 1}`,
      createdAt: new Date().toISOString(),
    })
  }
  // ONE undo entry removes the whole set — four ↩ presses for one press
  // of EXPO would read as broken.
  pushShapeUndo({
    label: 'exposures (4)',
    apply: async () => {
      await Promise.allSettled(placed.map((sh) => removeShapeSilent(sh.id)))
    },
  })
  for (const sh of placed) await persistShape(sh)
  notify('EXPOSURES 1-4 placed — Exposure 1 is the street side')
}

/** THE alarm path: every caller (command strip chips, decision-log
 *  benchmarks, resource-ledger ESCALATE) escalates AND logs through
 *  POST /api/alarm — the server appends the ic.benchmark row on the same
 *  request. Failures are VISIBLE: a silent 409 after a re-tap reads as
 *  "the alarm never went out", the opposite of the truth. */
export async function transmitAlarm(level: import('./types').AlarmLevel): Promise<void> {
  try {
    const res = await fetch('/api/alarm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level }),
    })
    if (!res.ok) {
      notify(
        res.status === 409
          ? 'ALARM ALREADY AT OR ABOVE THIS LEVEL — alarms only climb'
          : 'ALARM DID NOT REACH DISPATCH — check the link and try again',
        'red',
      )
    }
  } catch (err) {
    console.error('[alarm] failed:', err)
    notify('ALARM DID NOT REACH DISPATCH — check the link and try again', 'red')
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
let demoDispatchTimer: ReturnType<typeof setTimeout> | null = null
/** Next dispatchAssignment() call runs in compressed DEMO timing. */
let demoDispatchPending = false

export async function runDemoScenario(): Promise<void> {
  try {
    const { autocompleteAddress } = await import('./api/geosearch')
    const hits = await autocompleteAddress('100 Gold Street')
    const hit = hits.find((h) => h.borough === 'Manhattan') ?? hits[0]
    if (!hit) throw new Error('geocoder returned nothing for 100 Gold Street')
    await standUpIncident(hit, 'Structural Fire')
    const armedFor = getAppState().incident?.id
    // Let the fly-in land before units start rolling — but only dispatch if
    // THIS demo's incident is still current when the timer fires.
    if (demoDispatchTimer) clearTimeout(demoDispatchTimer)
    demoDispatchTimer = setTimeout(() => {
      demoDispatchTimer = null
      demoDispatchPending = true
      if (armedFor && getAppState().incident?.id === armedFor) void dispatchAssignment()
    }, 4000)
  } catch (err) {
    console.error('[demo] scenario failed:', err)
  }
}

/** "Dispatch Assignment" — the server spawns the simulated first alarm. */
export async function dispatchAssignment(): Promise<void> {
  setAppState({ dispatching: true })
  try {
    // Serialize behind the incident POST — see lastPersist.
    await lastPersist.catch(() => {})
    // Give the simulator the building profile so interior crews work real floors.
    const floors = getAppState().intel.pluto?.numFloors
    const demo = demoDispatchPending
    demoDispatchPending = false
    const res = await fetch('/api/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ floors, demo }),
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
