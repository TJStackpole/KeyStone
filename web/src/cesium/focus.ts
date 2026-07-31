import * as Cesium from 'cesium'
import type { SceneHandle } from './providers'

// ---------------------------------------------------------------------------
// ACTIVE INCIDENT focus (user feature): when a fire is stood up, render the
// incident building as sharply as possible and mark it with a TIGHT ring
// fixed on the building itself. The old treatment dimmed everything beyond
// ~4 blocks, which read as a giant spotlight "casting light" on the focus
// area — removed by user request. Two mechanisms remain:
//  - 3D tilesets (Google / OSM Buildings): halve the screen-space error near
//    the camera (which lives at the incident) and enable dynamic SSE so detail
//    falls off with distance — literally "far buildings matter less".
//  - A building-scale dashed ring hugging the incident building, visible in
//    the normal view and under the isolated building alike.
// ---------------------------------------------------------------------------

/** Building-scale ring — hugs the incident building, not the neighborhood. */
const RING_RADIUS_M = 70

const DEFAULT_SSE = 12 // photorealistic tiles stay legible even out of focus
const FOCUS_SSE = 8

function circle(lat: number, lon: number, radiusM: number, points: number): Cesium.Cartesian3[] {
  const R = 6371008.8
  const out: number[] = []
  for (let i = 0; i < points; i++) {
    const t = (i / points) * 2 * Math.PI
    out.push(
      lon + ((radiusM * Math.sin(t)) / (R * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI),
      lat + ((radiusM * Math.cos(t)) / R) * (180 / Math.PI),
    )
  }
  return Cesium.Cartesian3.fromDegreesArray(out)
}

export class FocusLayer {
  private source = new Cesium.CustomDataSource('active-incident-focus')
  private tilesetTouched = false

  constructor(private handle: SceneHandle) {
    void handle.viewer.dataSources.add(this.source)
  }

  /** Enable/disable the focus treatment for the given incident location. */
  apply(incident: { lat: number; lon: number } | null, enabled: boolean): void {
    this.source.entities.removeAll()
    const tileset = this.handle.buildingTileset

    if (!incident || !enabled) {
      if (tileset && this.tilesetTouched) {
        tileset.maximumScreenSpaceError = DEFAULT_SSE
        // Restore Cesium's DEFAULTS (dynamic SSE is on by default in 1.143) —
        // forcing it off stripped the distance-LOD optimization permanently.
        tileset.dynamicScreenSpaceError = true
        tileset.dynamicScreenSpaceErrorDensity = 2.0e-4
        tileset.dynamicScreenSpaceErrorFactor = 24.0
        this.tilesetTouched = false
      }
      return
    }

    // Detail boost at the fire, graceful falloff with distance.
    if (tileset) {
      tileset.maximumScreenSpaceError = FOCUS_SSE
      tileset.dynamicScreenSpaceError = true
      tileset.dynamicScreenSpaceErrorDensity = 6.0e-4
      tileset.dynamicScreenSpaceErrorFactor = 6.0
      this.tilesetTouched = true
    }

    // Building-fixed ring: marks the incident building without washing the
    // rest of the map. Ground-clamped, so it stays put in the normal view
    // AND under the isolated/lifted building.
    const ring = circle(incident.lat, incident.lon, RING_RADIUS_M, 48)
    this.source.entities.add({
      polyline: {
        positions: [...ring, ring[0]],
        width: 2.5,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString('#22d3ee').withAlpha(0.7),
          dashLength: 18,
        }),
        clampToGround: true,
      },
    })
  }
}
