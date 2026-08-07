// Cesium-free constants shared between the boot bundle and the city3d chunk.

/** Tile cache sizing for the photorealistic/OSM tilesets. */
export const TILE_CACHE_BYTES = 768 * 1024 * 1024

/** The operational area (NYC + ~50 mi), plain degrees. providers.ts builds
 *  the Cesium.Rectangle from this; the boot bundle box-tests against it
 *  directly so address search needs no engine. */
export const OPS_BOUNDS_DEG = { west: -75.22, south: 39.74, east: -72.74, north: 41.65 } as const

export function insideOpsBounds(lon: number, lat: number): boolean {
  return lon >= OPS_BOUNDS_DEG.west && lon <= OPS_BOUNDS_DEG.east && lat >= OPS_BOUNDS_DEG.south && lat <= OPS_BOUNDS_DEG.north
}
