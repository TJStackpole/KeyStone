import * as Cesium from 'cesium'
import { hasCapability } from '../profiles/manifest'
import { getAppState, setAppState, subscribeStore } from '../state/store'
import { getScene } from './scene'

// ---------------------------------------------------------------------------
// FDNY battle-view lock. The fireground is chaos — a free-tumbling 3D camera
// mid-incident is a liability, not a feature. While an incident is active in
// the FDNY workspace the camera is LOCKED to a small set of disciplined
// views:
//
//   TOP           north-up, straight down over the incident — zoom only
//   N / E / S / W facade elevation from that side of the building, with
//                 floor ▲▼ stepping so the operator battle-tracks interior
//                 members floor by floor
//
// Rotation/tilt/pan are disabled while locked; zoom stays live in every
// mode. ISOLATE and ground view are deliberate other camera modes — they
// suspend the lock and it re-engages when they exit. Ending the incident
// (or switching to a non-FDNY workspace) restores the free camera exactly
// as it was configured before the lock.
// ---------------------------------------------------------------------------

export type ViewLockMode = 'off' | 'top' | 'north' | 'east' | 'south' | 'west'

export const SIDE_HEADING_DEG: Record<'north' | 'east' | 'south' | 'west', number> = {
  // Camera sits on the named side of the building, looking back at it.
  north: 180, // positioned north, facing south
  east: 270,
  south: 0,
  west: 90,
}

/** Where the camera STANDS relative to building center, per side. */
const SIDE_BEARING_DEG: Record<'north' | 'east' | 'south' | 'west', number> = {
  north: 0,
  east: 90,
  south: 180,
  west: 270,
}

const TOP_DEFAULT_ABOVE_M = 320 // above the roof — reads the whole block
const SIDE_PITCH_DEG = -8 // just enough down-angle to keep street context

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

/** Building vitals with graceful fallbacks while open-data layers stream in. */
function buildingRef() {
  const s = getAppState()
  const z0 = s.floorRef?.z0 ?? 0
  const storeyM = s.floorRef?.storeyM ?? 3.2
  const heightM = s.targetHeightM ?? 30
  const floors = s.intel.pluto?.numFloors ?? Math.max(1, Math.round(heightM / storeyM))
  // Center on the FOOTPRINT, not the address point: the side views must sit
  // on the perpendicular axis through the middle of that face, and the
  // standoff must clear half the building's own depth.
  const b = s.targetBounds
  const centerLat = b ? (b.minLat + b.maxLat) / 2 : (s.incident?.lat ?? 0)
  const centerLon = b ? (b.minLon + b.maxLon) / 2 : (s.incident?.lon ?? 0)
  const halfNS = b ? ((b.maxLat - b.minLat) / 2) * 111_320 : 20
  const halfEW = b
    ? ((b.maxLon - b.minLon) / 2) * 111_320 * Math.cos((centerLat * Math.PI) / 180)
    : 20
  return { z0, storeyM, heightM, floors, centerLat, centerLon, halfNS, halfEW }
}

export function viewLockFloors(): number {
  return buildingRef().floors
}

/** The scripted fire floor when the sim announced one — the natural landing
 *  floor for battle tracking. */
export function defaultBattleFloor(): number {
  const { timeline } = getAppState()
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].kind === 'sim.dispatched') {
      const p = (timeline[i].payload ?? {}) as { fireFloor?: number }
      if (p.fireFloor) return Math.min(p.fireFloor, buildingRef().floors)
    }
  }
  return 1
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
  ctl.enableTranslate = false
  ctl.enableLook = false
  ctl.enableZoom = true // zoom stays live in every locked mode
  const { heightM } = buildingRef()
  if (mode === 'top') {
    ctl.minimumZoomDistance = heightM + 40 // never dive through the roof
    ctl.maximumZoomDistance = 4000
  } else {
    ctl.minimumZoomDistance = 18
    ctl.maximumZoomDistance = 500
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

/** Fly the camera to the current lock mode/floor. Fast + interruptible —
 *  rapid floor stepping replaces the in-flight tween seamlessly. */
export function applyViewLockCamera(durationS = 0.6): void {
  const s = getAppState()
  const scene = getScene()
  const inc = s.incident
  if (!scene || !inc || s.viewLock === 'off') return
  const { z0, storeyM, heightM, centerLat, centerLon, halfNS, halfEW } = buildingRef()
  lockController(s.viewLock)
  if (s.viewLock === 'top') {
    scene.viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(centerLon, centerLat, z0 + heightM + TOP_DEFAULT_ABOVE_M),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: durationS,
    })
    return
  }
  const side = s.viewLock
  const floor = Math.max(1, s.viewLockFloor)
  // Perpendicular, centered facade view: the camera sits on the compass axis
  // through the footprint CENTER of that face, standing off half the
  // building's own depth plus room for the facade and a floor of context.
  const halfDepth = side === 'north' || side === 'south' ? halfNS : halfEW
  const standoffM = halfDepth + Math.min(280, Math.max(45, heightM * 1.3))
  const pos = offsetDeg(centerLat, centerLon, SIDE_BEARING_DEG[side], standoffM)
  const eyeZ = z0 + (floor - 0.5) * storeyM + 2
  scene.viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, eyeZ + standoffM * Math.tan((-SIDE_PITCH_DEG * Math.PI) / 180)),
    orientation: {
      heading: Cesium.Math.toRadians(SIDE_HEADING_DEG[side]),
      pitch: Cesium.Math.toRadians(SIDE_PITCH_DEG),
      roll: 0,
    },
    duration: durationS,
  })
}

export function setViewLockMode(mode: Exclude<ViewLockMode, 'off'>): void {
  const patch: Record<string, unknown> = { viewLock: mode }
  // Entering a side view lands on the fire floor when the sim announced one.
  if (mode !== 'top' && getAppState().viewLock === 'top') patch.viewLockFloor = defaultBattleFloor()
  setAppState(patch)
  applyViewLockCamera(0.7)
}

export function stepViewLockFloor(delta: number): void {
  const s = getAppState()
  if (s.viewLock === 'off' || s.viewLock === 'top') return
  const next = Math.max(1, Math.min(viewLockFloors(), s.viewLockFloor + delta))
  if (next === s.viewLockFloor) return
  setAppState({ viewLockFloor: next })
  applyViewLockCamera(0.25) // fast — holding the arrow steps floors fluidly
}

function engage(): void {
  setAppState({ viewLock: 'top', viewLockFloor: defaultBattleFloor() })
  applyViewLockCamera(1.2)
}

function disengage(): void {
  unlockController()
  setAppState({ viewLock: 'off' })
}

/**
 * Store-driven state machine (attached with the scene, like the render-mode
 * controller): engages whenever the FDNY workspace has an active incident,
 * suspends for the deliberate special camera modes, re-engages when they
 * exit, and fully releases when the incident ends.
 */
export function attachViewLockController(): () => void {
  let lastShould = false
  const apply = () => {
    const s = getAppState()
    const should =
      s.sceneReady &&
      !!s.incident &&
      hasCapability(s.profile, 'tactical.view-lock') &&
      !s.isolateMode &&
      !s.groundViewActive &&
      !s.watchCommand &&
      !s.replay.active
    if (should === lastShould) return
    lastShould = should
    if (should && s.viewLock === 'off') engage()
    else if (!should && s.viewLock !== 'off') disengage()
  }
  const unsubscribe = subscribeStore(apply)
  apply()
  return () => {
    unsubscribe()
    if (getAppState().viewLock !== 'off') disengage()
  }
}
