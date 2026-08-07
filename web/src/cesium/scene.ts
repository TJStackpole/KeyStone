import { attachRenderModeController } from './renderMode'
import { attachViewLockController } from './viewLock'
import * as Cesium from 'cesium'
import type { SceneHandle } from './providers'
import { DrawController } from '../ics/draw'
import { BoundaryLayer } from './boundaries'
import { FocusLayer } from './focus'
import { FootprintLayer } from './footprints'
import { ExposureLayer } from './exposures'
import { HazardLayer } from './hazards'
import { IntelMarkerLayer } from './intelMarkers'
import { LotLayer } from './lots'
import { PoiLayer } from './poi'
import { RoadLayer } from './roads'
import { ShapeLayer } from './shapes'
import { StreetLabelLayer } from './streets'
import { TacticalModelLayer } from './tactical'
import { TrafficLayer } from './traffic'
import { UnitLayer } from './units'
import { _setSceneRegistry, _setTwinLayer } from './registry'

// ---------------------------------------------------------------------------
// Scene CONSTRUCTION — the heavy half of the registry split. This module
// (and through it every layer class) lives in the lazily-loaded city3d
// chunk; the boot bundle reads the singletons through the type-only
// cesium/registry.ts instead. registerScene() is only ever called from
// cesium/boot.ts, after Cesium.js itself has loaded.
// ---------------------------------------------------------------------------

let detachRenderMode: (() => void) | null = null
let detachViewLock: (() => void) | null = null
let drawController: DrawController | null = null

export function registerScene(h: SceneHandle): void {
  detachRenderMode = attachRenderModeController(h.viewer)
  detachViewLock = attachViewLockController()
  const shapeLayer = new ShapeLayer(h.viewer)
  drawController = new DrawController(h.viewer, shapeLayer)
  const unitLayer = new UnitLayer(h)
  _setSceneRegistry({
    handle: h,
    footprintLayer: new FootprintLayer(h.viewer),
    intelLayer: new IntelMarkerLayer(h.viewer),
    unitLayer,
    shapeLayer,
    drawController,
    boundaryLayer: new BoundaryLayer(h.viewer),
    focusLayer: new FocusLayer(h),
    streetLayer: new StreetLabelLayer(h.viewer),
    exposureLayer: new ExposureLayer(h.viewer),
    trafficLayer: new TrafficLayer(h.viewer),
    tacticalLayer: new TacticalModelLayer(h.viewer),
    lotLayer: new LotLayer(h.viewer),
    poiLayer: new PoiLayer(h.viewer),
    roadLayer: new RoadLayer(h.viewer),
    hazardLayer: new HazardLayer(h.viewer),
    twinLayer: null,
  })
  void import('./twin').then((m) => {
    _setTwinLayer(new m.TwinLayer(h.viewer))
  })
  if (import.meta.env.DEV) {
    // Debug handles for DevTools poking — dev builds only.
    ;(window as unknown as Record<string, unknown>).__wt = h
    ;(window as unknown as Record<string, unknown>).__cesium = Cesium
    ;(window as unknown as Record<string, unknown>).__wtUnitLayer = unitLayer
  }
}

export function unregisterScene(): void {
  detachRenderMode?.()
  detachRenderMode = null
  detachViewLock?.()
  detachViewLock = null
  drawController?.destroy()
  drawController = null
  _setSceneRegistry(null)
}
