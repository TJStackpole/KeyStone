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
