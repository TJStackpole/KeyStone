import type * as maplibregl from 'maplibre-gl'

// Tiny registry so non-map components (HOME / fly-to-incident buttons,
// future size-up strip) can drive the 2D camera without importing the
// component or the store growing map methods.

let current: maplibregl.Map | null = null

export function registerMap2D(map: maplibregl.Map | null): void {
  current = map
}

export function map2dActive(): boolean {
  return current !== null
}

export function flyTo2D(lat: number, lon: number, zoom = 16.5): void {
  current?.flyTo({ center: [lon, lat], zoom, duration: 900 })
}

// Draft cancellation — draw2d registers its canceller so tool switches and
// CLR ALL (which run in actions, far from the map) can drop an in-progress
// zone draft instead of welding its vertices into the next polygon.
let cancelDraft2D: (() => void) | null = null

export function registerDraw2DCancel(fn: (() => void) | null): void {
  cancelDraft2D = fn
}

export function cancelDraw2DDraft(): void {
  cancelDraft2D?.()
}
