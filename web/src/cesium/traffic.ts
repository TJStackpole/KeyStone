import * as Cesium from 'cesium'
import type { TrafficLink } from '../api/nyc'

// ---------------------------------------------------------------------------
// Live traffic overlay: NYC DOT / TRANSCOM link speeds drawn as ground-clamped
// route outlines, colored by current speed. Toggleable from Site Intel.
// ---------------------------------------------------------------------------

// Quick-reference palette (per the chief's spec): dark red = heavy traffic,
// red = traffic, yellow = light traffic, free-flowing links draw NOTHING.
const HEAVY = Cesium.Color.fromCssColorString('#7f1d1d').withAlpha(0.95) // <10 mph
const TRAFFIC = Cesium.Color.fromCssColorString('#ef4444').withAlpha(0.9) // 10–20
const LIGHT = Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.85) // 20–35
const FREE_FLOW_MPH = 35

function colorFor(speedMph: number): Cesium.Color | null {
  if (speedMph >= FREE_FLOW_MPH) return null // no traffic — no color
  if (speedMph >= 20) return LIGHT
  if (speedMph >= 10) return TRAFFIC
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
