import * as Cesium from 'cesium'
import type { SceneHandle } from './providers'
import { DrawController } from '../ics/draw'
import { BoundaryLayer } from './boundaries'
import { FocusLayer } from './focus'
import { FootprintLayer } from './footprints'
import { ExposureLayer } from './exposures'
import { IntelMarkerLayer } from './intelMarkers'
import { LotLayer } from './lots'
import { ShapeLayer } from './shapes'
import { StreetLabelLayer } from './streets'
import { TacticalModelLayer } from './tactical'
import { TrafficLayer } from './traffic'
import { UnitLayer } from './units'

/**
 * Module-level scene singleton so non-React modules (data layers, later the CoT
 * unit renderer) can reach the viewer without prop-drilling through React.
 */
let handle: SceneHandle | null = null
let footprintLayer: FootprintLayer | null = null
let intelLayer: IntelMarkerLayer | null = null
let unitLayer: UnitLayer | null = null
let shapeLayer: ShapeLayer | null = null
let drawController: DrawController | null = null
let boundaryLayer: BoundaryLayer | null = null
let focusLayer: FocusLayer | null = null
let streetLayer: StreetLabelLayer | null = null
let exposureLayer: ExposureLayer | null = null
let trafficLayer: TrafficLayer | null = null
let tacticalLayer: TacticalModelLayer | null = null
let lotLayer: LotLayer | null = null

export function registerScene(h: SceneHandle): void {
  handle = h
  footprintLayer = new FootprintLayer(h.viewer)
  intelLayer = new IntelMarkerLayer(h.viewer)
  unitLayer = new UnitLayer(h.viewer)
  shapeLayer = new ShapeLayer(h.viewer)
  drawController = new DrawController(h.viewer, shapeLayer)
  boundaryLayer = new BoundaryLayer(h.viewer)
  focusLayer = new FocusLayer(h)
  streetLayer = new StreetLabelLayer(h.viewer)
  exposureLayer = new ExposureLayer(h.viewer)
  trafficLayer = new TrafficLayer(h.viewer)
  tacticalLayer = new TacticalModelLayer(h.viewer)
  lotLayer = new LotLayer(h.viewer)
  if (import.meta.env.DEV) {
    // Debug handles for DevTools poking — dev builds only.
    ;(window as unknown as Record<string, unknown>).__wt = h
    ;(window as unknown as Record<string, unknown>).__cesium = Cesium
    ;(window as unknown as Record<string, unknown>).__wtUnitLayer = unitLayer
  }
}

export function unregisterScene(): void {
  drawController?.destroy()
  handle = null
  footprintLayer = null
  intelLayer = null
  unitLayer = null
  shapeLayer = null
  drawController = null
  boundaryLayer = null
  focusLayer = null
  streetLayer = null
  exposureLayer = null
  trafficLayer = null
  tacticalLayer = null
  lotLayer = null
}

export function getTrafficLayer(): TrafficLayer | null {
  return trafficLayer
}

export function getStreetLayer(): StreetLabelLayer | null {
  return streetLayer
}

export function getExposureLayer(): ExposureLayer | null {
  return exposureLayer
}

export function getShapeLayer(): ShapeLayer | null {
  return shapeLayer
}

export function getDrawController(): DrawController | null {
  return drawController
}

export function getBoundaryLayer(): BoundaryLayer | null {
  return boundaryLayer
}

export function getFocusLayer(): FocusLayer | null {
  return focusLayer
}

export function getIntelLayer(): IntelMarkerLayer | null {
  return intelLayer
}

export function getUnitLayer(): UnitLayer | null {
  return unitLayer
}

export function getScene(): SceneHandle | null {
  return handle
}

export function getFootprintLayer(): FootprintLayer | null {
  return footprintLayer
}

export function getTacticalLayer(): TacticalModelLayer | null {
  return tacticalLayer
}

export function getLotLayer(): LotLayer | null {
  return lotLayer
}
