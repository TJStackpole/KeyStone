import * as Cesium from 'cesium'
import type { SceneHandle } from './providers'

// ---------------------------------------------------------------------------
// ACTIVE INCIDENT focus (user feature): when a fire is stood up, render the
// incident building as sharply as possible and de-emphasize everything beyond
// ~4 blocks. Two mechanisms, both modes covered:
//  - 3D tilesets (Google / OSM Buildings): halve the screen-space error near
//    the camera (which lives at the incident) and enable dynamic SSE so detail
//    falls off with distance — literally "far buildings matter less".
//  - A draped dim mask outside a 4-block radius makes the focus area explicit
//    (works over photorealistic tiles, extrusions, and the bare basemap).
// ---------------------------------------------------------------------------

/** ~4 Manhattan blocks. */
const FOCUS_RADIUS_M = 350
/** Outer edge of the dim mask (beyond this the map fades under the veil). */
const MASK_OUTER_M = 15_000

const DEFAULT_SSE = 16
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
        tileset.dynamicScreenSpaceError = false
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

    // Dim veil outside the 4-block focus ring, draped over whatever's below.
    this.source.entities.add({
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(circle(incident.lat, incident.lon, MASK_OUTER_M, 64), [
          new Cesium.PolygonHierarchy(circle(incident.lat, incident.lon, FOCUS_RADIUS_M, 48)),
        ]),
        material: Cesium.Color.fromCssColorString('#05080d').withAlpha(0.42),
        classificationType: Cesium.ClassificationType.BOTH,
      },
    })
    // Focus ring edge.
    this.source.entities.add({
      polyline: {
        positions: [...circle(incident.lat, incident.lon, FOCUS_RADIUS_M, 48), circle(incident.lat, incident.lon, FOCUS_RADIUS_M, 48)[0]],
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
