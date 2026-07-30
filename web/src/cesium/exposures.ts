import * as Cesium from 'cesium'
import type { ExposureLabel } from '../types'

const FILL = Cesium.Color.fromCssColorString('#fbbf24')
const BG = Cesium.Color.fromCssColorString('#0a0e14').withAlpha(0.8)

/**
 * FDNY exposure designations (1 = address side, then clockwise) around the
 * fire building — set by scenario command traffic or, later, by hand.
 */
export class ExposureLayer {
  private source = new Cesium.CustomDataSource('exposures')

  constructor(viewer: Cesium.Viewer) {
    void viewer.dataSources.add(this.source)
  }

  set(labels: ExposureLabel[]): void {
    this.source.entities.removeAll()
    for (const l of labels) {
      this.source.entities.add({
        id: `exposure:${l.text}`,
        position: Cesium.Cartesian3.fromDegrees(l.lon, l.lat, 0),
        label: {
          text: l.text,
          font: `700 11px 'JetBrains Mono', monospace`,
          fillColor: FILL,
          showBackground: true,
          backgroundColor: BG,
          backgroundPadding: new Cesium.Cartesian2(6, 3),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(400, 1, 4000, 0.55),
        },
      })
    }
  }

  clear(): void {
    this.source.entities.removeAll()
  }
}
