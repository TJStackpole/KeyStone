import * as Cesium from 'cesium'
import type { SceneHandle } from './providers'
import { FootprintLayer } from './footprints'
import { IntelMarkerLayer } from './intelMarkers'
import { UnitLayer } from './units'

/**
 * Module-level scene singleton so non-React modules (data layers, later the CoT
 * unit renderer) can reach the viewer without prop-drilling through React.
 */
let handle: SceneHandle | null = null
let footprintLayer: FootprintLayer | null = null
let intelLayer: IntelMarkerLayer | null = null
let unitLayer: UnitLayer | null = null

export function registerScene(h: SceneHandle): void {
  handle = h
  footprintLayer = new FootprintLayer(h.viewer)
  intelLayer = new IntelMarkerLayer(h.viewer)
  unitLayer = new UnitLayer(h.viewer)
  if (import.meta.env.DEV) {
    // Debug handle for DevTools poking — dev builds only.
    ;(window as unknown as Record<string, unknown>).__wt = h
    ;(window as unknown as Record<string, unknown>).__cesium = Cesium
  }
}

export function unregisterScene(): void {
  handle = null
  footprintLayer = null
  intelLayer = null
  unitLayer = null
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
