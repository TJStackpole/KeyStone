import * as Cesium from 'cesium'
import type { StreetLabel } from '../api/nyc'

/**
 * Street-name captions around the incident (NYC Street Centerline data) —
 * rendered as canvas-text billboards ROTATED to the street's bearing, so
 * names run along their streets like a printed map. alignedAxis keeps the
 * rotation glued to map north, so labels stay street-aligned as the camera
 * rotates. Clamped to the scene surface like every ground marker.
 */

const TEXT_FILL = '#cbdaea'
const TEXT_HALO = 'rgba(6, 10, 16, 0.92)'

const imageCache = new Map<string, HTMLCanvasElement>()

function textImage(text: string): HTMLCanvasElement {
  const cached = imageCache.get(text)
  if (cached) return cached
  const font = `600 22px 'JetBrains Mono', monospace` // 2x, downscaled for crispness
  const canvas = document.createElement('canvas')
  const measure = canvas.getContext('2d')!
  measure.font = font
  canvas.width = Math.ceil(measure.measureText(text).width) + 18
  canvas.height = 32
  const ctx = canvas.getContext('2d')!
  ctx.font = font
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 6
  ctx.strokeStyle = TEXT_HALO
  ctx.strokeText(text, 9, 17)
  ctx.fillStyle = TEXT_FILL
  ctx.fillText(text, 9, 17)
  imageCache.set(text, canvas)
  return canvas
}

/** Billboard rotation (CCW from screen-east with map-north up) for a street bearing. */
function rotationFor(bearingDeg: number): number {
  // Angle of the street direction measured CCW from east, kept in (-90, 90]
  // so text never renders upside down.
  let theta = 90 - bearingDeg
  while (theta > 90) theta -= 180
  while (theta <= -90) theta += 180
  return Cesium.Math.toRadians(theta)
}

export class StreetLabelLayer {
  private source = new Cesium.CustomDataSource('street-labels')
  private visible = true

  constructor(viewer: Cesium.Viewer) {
    void viewer.dataSources.add(this.source)
  }

  set(labels: StreetLabel[]): void {
    this.source.entities.removeAll()
    for (const s of labels) {
      this.source.entities.add({
        id: `street:${s.name}`,
        position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 0),
        billboard: {
          image: textImage(s.name),
          scale: 0.5,
          rotation: rotationFor(s.bearingDeg),
          alignedAxis: Cesium.Cartesian3.UNIT_Z,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(400, 1, 3500, 0.55),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5500),
        },
      })
    }
    this.source.show = this.visible
  }

  setVisible(show: boolean): void {
    this.visible = show
    this.source.show = show
  }

  clear(): void {
    this.source.entities.removeAll()
  }
}
