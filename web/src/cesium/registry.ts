// ---------------------------------------------------------------------------
// Scene registry — the CESIUM-FREE half of the old scene.ts split.
//
// Everything here is `import type` (erased at build), so the boot bundle can
// reach the scene/layer singletons without dragging a single 3D
// implementation module — those live in the lazily-loaded city3d chunk
// (scene.ts + the layer classes), which populates this registry when the
// engine boots. Every getter is null until then; callers already treat null
// as "3D not up yet".
// ---------------------------------------------------------------------------

import type { SceneHandle } from './providers'
import type { BoundaryLayer } from './boundaries'
import type { DrawController } from '../ics/draw'
import type { ExposureLayer } from './exposures'
import type { FocusLayer } from './focus'
import type { FootprintLayer } from './footprints'
import type { HazardLayer } from './hazards'
import type { IntelMarkerLayer } from './intelMarkers'
import type { LotLayer } from './lots'
import type { PoiLayer } from './poi'
import type { RoadLayer } from './roads'
import type { ShapeLayer } from './shapes'
import type { StreetLabelLayer } from './streets'
import type { TacticalModelLayer } from './tactical'
import type { TrafficLayer } from './traffic'
import type { TwinLayer } from './twin'
import type { UnitLayer } from './units'

export interface SceneRegistry {
  handle: SceneHandle
  footprintLayer: FootprintLayer
  intelLayer: IntelMarkerLayer
  unitLayer: UnitLayer
  shapeLayer: ShapeLayer
  drawController: DrawController
  boundaryLayer: BoundaryLayer
  focusLayer: FocusLayer
  streetLayer: StreetLabelLayer
  exposureLayer: ExposureLayer
  trafficLayer: TrafficLayer
  tacticalLayer: TacticalModelLayer
  lotLayer: LotLayer
  poiLayer: PoiLayer
  roadLayer: RoadLayer
  hazardLayer: HazardLayer
  twinLayer: TwinLayer | null // arrives via its own lazy chunk
}

let reg: SceneRegistry | null = null

/** scene.ts (city3d chunk) wires the built layers in here. */
export function _setSceneRegistry(next: SceneRegistry | null): void {
  reg = next
}
export function _setTwinLayer(twin: TwinLayer): void {
  if (reg) reg.twinLayer = twin
}

export const getScene = (): SceneHandle | null => reg?.handle ?? null
export const getFootprintLayer = (): FootprintLayer | null => reg?.footprintLayer ?? null
export const getIntelLayer = (): IntelMarkerLayer | null => reg?.intelLayer ?? null
export const getUnitLayer = (): UnitLayer | null => reg?.unitLayer ?? null
export const getShapeLayer = (): ShapeLayer | null => reg?.shapeLayer ?? null
export const getDrawController = (): DrawController | null => reg?.drawController ?? null
export const getBoundaryLayer = (): BoundaryLayer | null => reg?.boundaryLayer ?? null
export const getFocusLayer = (): FocusLayer | null => reg?.focusLayer ?? null
export const getStreetLayer = (): StreetLabelLayer | null => reg?.streetLayer ?? null
export const getExposureLayer = (): ExposureLayer | null => reg?.exposureLayer ?? null
export const getTrafficLayer = (): TrafficLayer | null => reg?.trafficLayer ?? null
export const getTacticalLayer = (): TacticalModelLayer | null => reg?.tacticalLayer ?? null
export const getLotLayer = (): LotLayer | null => reg?.lotLayer ?? null
export const getPoiLayer = (): PoiLayer | null => reg?.poiLayer ?? null
export const getRoadLayer = (): RoadLayer | null => reg?.roadLayer ?? null
export const getHazardLayer = (): HazardLayer | null => reg?.hazardLayer ?? null
export const getTwinLayer = (): TwinLayer | null => reg?.twinLayer ?? null
