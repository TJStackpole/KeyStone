import * as Cesium from 'cesium'
import type { TrafficLink } from '../api/nyc'

// ---------------------------------------------------------------------------
// Live traffic overlay: NYC DOT / TRANSCOM link speeds drawn as ground-clamped
// route outlines, colored by current speed. Toggleable from Site Intel.
// ---------------------------------------------------------------------------

// Two-class palette (chief's spec, tightened 2026-08-05): red = heavy
// (<10 mph), amber = moderate (10–20). Anything moving faster is NOT
// congestion and draws NOTHING — the map only flags what slows the response.
export const TRAFFIC_MODERATE_MPH = 20
export const TRAFFIC_HEAVY_MPH = 10
const HEAVY = Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.95) // <10 mph
const MODERATE = Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.9) // 10–20

function colorFor(speedMph: number): Cesium.Color | null {
  if (speedMph >= TRAFFIC_MODERATE_MPH) return null // free enough — no color
  if (speedMph >= TRAFFIC_HEAVY_MPH) return MODERATE
  return HEAVY
}

export class TrafficLayer {
  private source = new Cesium.CustomDataSource('traffic')
  private visible = false

  constructor(viewer: Cesium.Viewer) {
    void viewer.dataSources.add(this.source)
    this.source.show = false
  }

  set(links: TrafficLink[]): void {
    this.source.entities.removeAll()
    for (let i = 0; i < links.length; i++) {
      const l = links[i]
      const color = colorFor(l.speedMph)
      if (!color) continue
      this.source.entities.add({
        id: `traffic:${i}:${l.name}`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray(l.positions.flat()),
          width: 5,
          material: color,
          clampToGround: true,
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
