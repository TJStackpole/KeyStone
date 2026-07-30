import * as Cesium from 'cesium'
import type { StreetLabel } from '../api/nyc'

const TEXT = Cesium.Color.fromCssColorString('#c3d3e4')
const BG = Cesium.Color.fromCssColorString('#0a0e14').withAlpha(0.55)

/**
 * Street-name captions around the incident (NYC Street Centerline data) —
 * photorealistic tiles carry no labels, so the fireground reads like a map
 * only with these. Clamped to the scene surface like every ground marker.
 */
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
        label: {
          text: s.name,
          font: `600 10px 'JetBrains Mono', monospace`,
          fillColor: TEXT,
          showBackground: true,
          backgroundColor: BG,
          backgroundPadding: new Cesium.Cartesian2(4, 2),
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
