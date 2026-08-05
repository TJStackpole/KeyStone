import * as Cesium from 'cesium'
import { notify } from '../components/NoticeChip'
import { hasCapability } from '../profiles/manifest'
import { getAppState, setAppState, subscribeStore } from '../state/store'
import { flyToTactical } from './providers'
import { getScene, getTacticalLayer, getTwinLayer } from './scene'

// ---------------------------------------------------------------------------
// FDNY battle-view lock. The fireground is chaos — a free-tumbling 3D camera
// mid-incident is a liability, not a feature. The lock arms when the
// operator commits to the structure: ACTIVE INCIDENT is up AND ISOLATE is
// checked on. From that moment the camera is LOCKED to disciplined views of
// the isolated building:
//
//   N / E / S / W true head-on elevation of the building FACE nearest that
//                 cardinal — aligned to the structure's own axes, not the
//                 world's (Manhattan's grid runs ~29° off true north; a due-
//                 north camera would stare at the corner). The whole facade
//                 fits in frame; ▲▼ scrolls a highlighted floor band for
//                 member tracking without ever yanking the operator's zoom.
//   TOP           north-up, straight down over the structure — zoom only
//
// Rotation/tilt/pan are disabled while locked; zoom stays live in every
// mode. Geometry follows the ISOLATE session's own floor reference
// (isolateFloors) so the views track the lifted / MODEL-scaled structure,
// not the pre-clip street. Ground view suspends the lock; unchecking
// ISOLATE releases it and flies back to the standard tactical frame with
// the free camera restored exactly as it was configured before the lock.
// ---------------------------------------------------------------------------

export type ViewLockMode = 'off' | 'orbit' | 'top' | 'north' | 'east' | 'south' | 'west'
type SideMode = Exclude<ViewLockMode, 'off' | 'top' | 'orbit'>

const CARDINAL_DEG: Record<SideMode, number> = { north: 0, east: 90, south: 180, west: 270 }

const TOP_DEFAULT_ABOVE_M = 320 // above the roof — reads the whole block

interface SavedController {
  enableRotate: boolean
  enableTilt: boolean
  enableTranslate: boolean
  enableLook: boolean
  minimumZoomDistance: number
  maximumZoomDistance: number
}
let saved: SavedController | null = null

function offsetDeg(lat: number, lon: number, bearingDeg: number, distM: number): { lat: number; lon: number } {
  const rad = (bearingDeg * Math.PI) / 180
  return {
    lat: lat + (distM * Math.cos(rad)) / 111_320,
    lon: lon + (distM * Math.sin(rad)) / (111_320 * Math.cos((lat * Math.PI) / 180)),
  }
}

/** Building vitals with graceful fallbacks while open-data layers stream in.
 *  Inside ISOLATE the session's own floor reference wins — it carries the
 *  google-mode ground lift and the MODEL view's vertical stretch, so facade
 *  eyes and the roof ceiling hug the structure the operator actually sees. */
function buildingRef() {
  const s = getAppState()
  const ref = s.isolateFloors ?? s.floorRef
  const z0 = ref?.z0 ?? 0
  const storeyM = ref?.storeyM ?? 3.2
  const scaleK = s.isolateMode && s.isolateView === 'model' ? s.isolateScale : 1
  const heightM = (s.targetHeightM ?? 30) * scaleK
  // Floor COUNT must come from the same source as storeyM: the isolate
  // schematic prefers the dispatch's announced count (which can beat PLUTO
  // to the scene) — a PLUTO-first count here would let the stepper walk the
  // highlight past the schematic's roof.
  const floors =
    s.isolateFloors?.floors ?? s.intel.pluto?.numFloors ?? Math.max(1, Math.round(heightM / storeyM))
  const b = s.targetBounds
  return {
    z0,
    storeyM,
    heightM,
    floors,
    centerLat: b?.centerLat ?? s.incident?.lat ?? 0,
    centerLon: b?.centerLon ?? s.incident?.lon ?? 0,
    bearingA: b?.bearingA ?? 0,
    halfA: b?.halfA ?? 20,
    halfB: b?.halfB ?? 20,
  }
}

/** Absolute angular distance between two bearings, degrees in [0, 180]. */
function angDistDeg(a: number, b: number): number {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180)
}

/**
 * The building face each cardinal button means: of the structure's four
 * outward facade normals (its own axes, from the footprint's dominant edge
 * bearing), the one pointing most nearly at that compass direction. `depth`
 * is the half-extent the camera must clear along the normal; `width` is the
 * facade's half-width across it.
 */
function facadeFor(side: SideMode): { normal: number; depth: number; width: number } {
  const { bearingA, halfA, halfB } = buildingRef()
  const cardinal = CARDINAL_DEG[side]
  let best = { normal: 0, depth: halfA, width: halfB }
  let bestD = Infinity
  for (let i = 0; i < 4; i++) {
    const normal = (((bearingA + i * 90) % 360) + 360) % 360
    const alongA = i % 2 === 0 // normals on the A axis front the end walls
    const d = angDistDeg(normal, cardinal)
    if (d < bestD) {
      bestD = d
      best = { normal, depth: alongA ? halfA : halfB, width: alongA ? halfB : halfA }
    }
  }
  return best
}

export function viewLockFloors(): number {
  return buildingRef().floors
}

/** The scripted fire floor when the sim announced one for THIS incident. */
export function battleFireFloor(): number | null {
  const { timeline, incident } = getAppState()
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].kind === 'sim.dispatched') {
      const p = (timeline[i].payload ?? {}) as { fireFloor?: number; incidentId?: string }
      if (p.incidentId && incident && p.incidentId !== incident.id) return null
      if (p.fireFloor) return Math.min(p.fireFloor, buildingRef().floors)
    }
  }
  return null
}

/** The natural landing floor for battle tracking: the fire floor, else 1. */
export function defaultBattleFloor(): number {
  return battleFireFloor() ?? 1
}

function lockController(mode: Exclude<ViewLockMode, 'off'>): void {
  const scene = getScene()
  if (!scene) return
  const ctl = scene.viewer.scene.screenSpaceCameraController
  if (!saved) {
    saved = {
      enableRotate: ctl.enableRotate,
      enableTilt: ctl.enableTilt,
      enableTranslate: ctl.enableTranslate,
      enableLook: ctl.enableLook,
      minimumZoomDistance: ctl.minimumZoomDistance,
      maximumZoomDistance: ctl.maximumZoomDistance,
    }
  }
  ctl.enableRotate = false
  ctl.enableTilt = false
  // TOP is a working plan view: panning stays live so the operator can
  // drift and re-center over the building. Facade views stay fully pinned.
  ctl.enableTranslate = mode === 'top'
  ctl.enableLook = false
  ctl.enableZoom = true // zoom stays live in every locked mode
  const { heightM } = buildingRef()
  if (mode === 'top') {
    ctl.minimumZoomDistance = heightM + 40 // never dive through the roof
    ctl.maximumZoomDistance = 4000
  } else {
    ctl.minimumZoomDistance = 18
    ctl.maximumZoomDistance = 1500 // room to pull back from a block-long facade
  }
}

function unlockController(): void {
  const scene = getScene()
  if (!scene || !saved) return
  const ctl = scene.viewer.scene.screenSpaceCameraController
  ctl.enableRotate = saved.enableRotate
  ctl.enableTilt = saved.enableTilt
  ctl.enableTranslate = saved.enableTranslate
  ctl.enableLook = saved.enableLook
  ctl.enableZoom = true
  ctl.minimumZoomDistance = saved.minimumZoomDistance
  ctl.maximumZoomDistance = saved.maximumZoomDistance
  saved = null
}

/** Keep the isolate schematic's highlighted floor band on the tracked floor
 *  (facade modes only — TOP and the free camera clear it). */
function syncFocusFloor(): void {
  const s = getAppState()
  const focusable = s.isolateMode && s.viewLock !== 'off' && s.viewLock !== 'top' && s.viewLock !== 'orbit'
  getTacticalLayer()?.setFocusFloor(focusable ? s.viewLockFloor : null)
  // Blueprint twin: TOP + isolate = the tracked floor as a room-by-room
  // plan cutaway; any other mode restores the full 3D twin.
  getTwinLayer()?.setPlanFloor(s.isolateMode && s.viewLock === 'top' ? s.viewLockFloor : null)
}

/**
 * Operator LOCK toggle: suspending frees the camera completely (rotate,
 * tilt, pan) while the rail, floor highlight, and plan cutaway stay up;
 * resuming re-pins and flies back to the current view.
 */
export function setViewLockSuspended(suspended: boolean): void {
  const s = getAppState()
  if (s.viewLock === 'off' || s.viewLockSuspended === suspended) return
  setAppState({ viewLockSuspended: suspended })
  if (suspended) {
    unlockController()
    notify('CAMERA FREE — press LOCK to snap back to the disciplined view')
  } else {
    applyViewLockCamera(0.7)
  }
}

/** Fly the camera to the current lock mode. Fast + interruptible. */
export function applyViewLockCamera(durationS = 0.6): void {
  const s = getAppState()
  const scene = getScene()
  const inc = s.incident
  if (!scene || !inc || s.viewLock === 'off' || s.viewLockSuspended) return
  if (s.viewLock === 'orbit') {
    lockController('orbit')
    startOrbit()
    return
  }
  const { z0, heightM, centerLat, centerLon } = buildingRef()
  lockController(s.viewLock)
  if (s.viewLock === 'top') {
    scene.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, z0 + heightM + TOP_DEFAULT_ABOVE_M),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: durationS,
    })
    syncFocusFloor()
    return
  }
  // TRUE ELEVATION of the chosen face: eye at the TRACKED floor (engage
  // lands on the fire floor), camera aimed at the structure — one flight
  // path shared with the floor stepper.
  flyFacadeTo(floorCenterZ(s.viewLockFloor), durationS)
  syncFocusFloor()
}

export function setViewLockMode(mode: Exclude<ViewLockMode, 'off'>): void {
  const prev = getAppState().viewLock
  if (mode !== 'orbit') stopOrbitTick()
  const patch: Record<string, unknown> = { viewLock: mode, viewLockSuspended: false }
  // FIXED DIRECTIONS START AT THE GROUND: a facade entered from orbit, TOP,
  // or fresh begins at street level — floor steps then carry the vantage up
  // the building. (The fire-floor jump chip is one press away.)
  if (mode !== 'top' && mode !== 'orbit' && prev !== 'north' && prev !== 'east' && prev !== 'south' && prev !== 'west') {
    patch.viewLockFloor = 1
  }
  setAppState(patch)
  if (mode === 'orbit') {
    lockController('orbit')
    // Pick the lap up from wherever the camera currently faces.
    const cam = getScene()?.viewer.camera
    if (cam) orbitTheta = (((Cesium.Math.toDegrees(cam.heading) + 180) % 360) + 360) % 360
    setAppState({ viewLockOrbitPaused: false })
    startOrbit()
    syncFocusFloor()
    return
  }
  applyViewLockCamera(0.7)
}

export function stepViewLockFloor(delta: number): void {
  jumpViewLockFloor(getAppState().viewLockFloor + delta)
}

/** Meters above ground of a floor's eye level — the SAME ladder the
 *  schematic's floor bands use ((n − ½)·storeyM over sampled ground), so the
 *  camera levels exactly with the highlighted band. */
function floorAglM(floor: number): number {
  const { storeyM, floors } = buildingRef()
  return (Math.max(1, Math.min(floors, floor)) - 0.5) * storeyM
}

function floorCenterZ(floor: number): number {
  return buildingRef().z0 + floorAglM(floor)
}

/** The FIXED standoff off a facade: the whole structure — grade to roof,
 *  full width — fits in frame with the camera AIMED AT ITS CENTER. One
 *  distance per facade; every floor command returns the camera to it, so
 *  the sight picture never drifts off the building. */
function fullFrameStandoffM(side: SideMode): number {
  const { heightM } = buildingRef()
  const { depth, width } = facadeFor(side)
  const frustum = getScene()?.viewer.camera.frustum
  const fovy =
    (frustum instanceof Cesium.PerspectiveFrustum ? frustum.fovy : undefined) ?? Cesium.Math.toRadians(45)
  const aspect = (frustum instanceof Cesium.PerspectiveFrustum ? frustum.aspectRatio : undefined) || 1.6
  const fovx = 2 * Math.atan(Math.tan(fovy / 2) * aspect)
  return depth + Math.max(30, (heightM / 2 + 8) / Math.tan(fovy / 2), (width + 10) / Math.tan(fovx / 2))
}

// ------------------------------- Auto-orbit ---------------------------------

let orbitTimer: ReturnType<typeof setInterval> | null = null
let orbitTheta = 0

/** Orbit radius: the whole structure in frame from any bearing. */
function orbitStandoffM(): number {
  const { heightM, halfA, halfB } = buildingRef()
  const frustum = getScene()?.viewer.camera.frustum
  const fovy =
    (frustum instanceof Cesium.PerspectiveFrustum ? frustum.fovy : undefined) ?? Cesium.Math.toRadians(45)
  const aspect = (frustum instanceof Cesium.PerspectiveFrustum ? frustum.aspectRatio : undefined) || 1.6
  const fovx = 2 * Math.atan(Math.tan(fovy / 2) * aspect)
  const halfMax = Math.max(halfA, halfB)
  return halfMax + Math.max(34, (heightM / 2 + 10) / Math.tan(fovy / 2), (halfMax + 12) / Math.tan(fovx / 2))
}

function applyOrbitCamera(): void {
  const scene = getScene()
  if (!scene) return
  const { z0, heightM, centerLat, centerLon } = buildingRef()
  const standoff = orbitStandoffM()
  const pos = offsetDeg(centerLat, centerLon, orbitTheta, standoff)
  // Slightly above the roofline, always aimed at the structure's center.
  const camZ = z0 + Math.max(heightM * 0.9, 8) + 4
  const pitch = Math.atan2(z0 + heightM / 2 - camZ, standoff)
  scene.viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, camZ),
    orientation: { heading: Cesium.Math.toRadians((orbitTheta + 180) % 360), pitch, roll: 0 },
  })
}

function stopOrbitTick(): void {
  if (orbitTimer) {
    clearInterval(orbitTimer)
    orbitTimer = null
  }
}

function startOrbit(): void {
  stopOrbitTick()
  applyOrbitCamera()
  // ~6°/s — one lap a minute. setView per tick (no tween), so the lap keeps
  // moving even in throttled panes and never fights the flight system.
  orbitTimer = setInterval(() => {
    const s = getAppState()
    if (s.viewLock !== 'orbit') {
      stopOrbitTick()
      return
    }
    if (s.viewLockOrbitPaused) return
    orbitTheta = (orbitTheta + 0.3) % 360
    applyOrbitCamera()
  }, 50)
}

/** ⏸/▶ on the LIVE VIEWS panel. Zoom works while paused — the orbit stops
 *  writing the camera, so the wheel is yours until you resume. */
export function setOrbitPaused(paused: boolean): void {
  if (getAppState().viewLock !== 'orbit') return
  setAppState({ viewLockOrbitPaused: paused })
}

/** Facade flight to an absolute elevation, re-latching a FREE camera and
 *  auto-adjusting to the fixed whole-building standoff — the camera flies
 *  to level with zAbs, squared to the facade, full structure in frame.
 *  Shared by floor jumps and the continuous height gauge. */
function flyFacadeTo(zAbs: number, durationS: number): void {
  const s = getAppState()
  if (s.viewLock === 'off' || s.viewLock === 'top' || s.viewLock === 'orbit') return
  const scene = getScene()
  if (!scene) return
  // An explicit height/floor command means "put me level with THIS" — it
  // re-latches a FREE camera rather than moving only the readout.
  if (s.viewLockSuspended) {
    setAppState({ viewLockSuspended: false })
    lockController(s.viewLock)
  }
  const { centerLat, centerLon, z0, heightM } = buildingRef()
  const { normal } = facadeFor(s.viewLock)
  const standoffM = fullFrameStandoffM(s.viewLock)
  const pos = offsetDeg(centerLat, centerLon, normal, standoffM)
  // LOCKED MEANS LOCKED ON THE BUILDING: the camera pitches from its eye
  // height to the structure's mid-height, so the building sits dead center
  // whatever floor the eye rides — never a horizon shot of dirt and sky
  // with a squat building lost in the band between.
  const midZ = z0 + heightM / 2
  const pitch = Math.atan2(midZ - zAbs, standoffM)
  scene.viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, zAbs),
    orientation: { heading: Cesium.Math.toRadians((normal + 180) % 360), pitch, roll: 0 },
    duration: durationS,
  })
}

/** Direct floor set (fire-floor quick jump, stepper, arrows). The VIEW rides
 *  the floor: the camera flies to eye level with it. */
export function jumpViewLockFloor(floor: number): void {
  const s = getAppState()
  if (s.viewLock === 'off' || s.viewLock === 'orbit') return
  // TOP view steps the PLAN floor (blueprint cutaway) — no camera motion.
  if (s.viewLock === 'top' && !s.isolateMode) return
  const next = Math.max(1, Math.min(viewLockFloors(), Math.round(floor)))
  // Same floor while still latched = nothing to do; suspended, the command
  // still re-latches and levels the camera.
  if (next === s.viewLockFloor && !s.viewLockSuspended) return
  setAppState({ viewLockFloor: next })
  syncFocusFloor()
  if (s.viewLock === 'top') return // plan view has no eye level
  flyFacadeTo(floorCenterZ(next), 0.5)
}

let hintShown = false

function engage(): void {
  // The LIVE VIEW opens on a slow lap of the structure — the size-up walk-
  // around, hands-free. ⏸ pauses it; N/E/S/W drop to ground-level facades.
  setViewLockMode('orbit')
  if (!hintShown) {
    hintShown = true
    notify('LIVE VIEW ORBITING THE STRUCTURE — ⏸ pauses · N/E/S/W faces climb from the ground · T top')
  }
}

function disengage(): void {
  stopOrbitTick()
  unlockController()
  setAppState({ viewLock: 'off', viewLockSuspended: false })
  syncFocusFloor()
  // Unchecking ISOLATE mid-incident: hand the operator back the standard
  // tactical frame instead of leaving them nose-to-facade with a freed
  // camera. Other exits (incident end, Watch Command, ground view, replay)
  // own their own camera — and their teardowns unwind isolate FIRST while
  // the incident is still in the store, so the decision must wait one
  // microtask for the rest of their synchronous teardown to land.
  queueMicrotask(() => {
    const s = getAppState()
    const scene = getScene()
    if (
      scene &&
      s.incident &&
      s.viewLock === 'off' &&
      !s.isolateMode &&
      !s.groundViewActive &&
      !s.replay.active
    ) {
      flyToTactical(scene.viewer, s.incident.lat, s.incident.lon, 1.6)
    }
  })
}

/**
 * Store-driven state machine (attached with the scene, like the render-mode
 * controller): arms when the FDNY workspace has an active incident AND the
 * operator checks ISOLATE on, suspends for ground view / Watch Command /
 * replay, and releases (restoring the free camera) when ISOLATE is
 * unchecked or the incident ends.
 */
export function attachViewLockController(): () => void {
  let lastShould = false
  let lastFloorsRef: unknown = null
  const apply = () => {
    const s = getAppState()
    const should =
      s.sceneReady &&
      !!s.incident &&
      hasCapability(s.profile, 'tactical.view-lock') &&
      s.isolateMode &&
      !s.groundViewActive &&
      !s.replay.active
    if (should !== lastShould) {
      lastShould = should
      lastFloorsRef = s.isolateFloors
      if (should && s.viewLock === 'off') {
        // Teardowns write per-field (replay stops BEFORE isolate unwinds,
        // incident still set for one more write) — a raw engage here would
        // lock the camera mid-teardown. Defer one microtask and re-verify
        // the whole gate, mirroring disengage()'s deferral.
        queueMicrotask(() => {
          const n = getAppState()
          const stillShould =
            n.sceneReady &&
            !!n.incident &&
            hasCapability(n.profile, 'tactical.view-lock') &&
            n.isolateMode &&
            !n.groundViewActive &&
            !n.replay.active
          if (!stillShould) {
            lastShould = false
            return
          }
          if (n.viewLock === 'off') engage()
        })
      } else if (!should && s.viewLock !== 'off') disengage()
      return
    }
    // The isolate ON path lands its ground lift / schematic floors ASYNC
    // (street-level sample) — and MODEL scale chips rebuild them. Re-fly so
    // the locked views track the structure the operator actually sees.
    if (lastShould && s.isolateFloors !== lastFloorsRef) {
      lastFloorsRef = s.isolateFloors
      if (s.viewLock !== 'off') applyViewLockCamera(0.6)
    }
  }
  const unsubscribe = subscribeStore(apply)
  apply()
  return () => {
    unsubscribe()
    if (getAppState().viewLock !== 'off') disengage()
  }
}
