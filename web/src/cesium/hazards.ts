import * as Cesium from 'cesium'
import { lazy } from './lazy'
import type { WindObs } from '../api/weather'
import type { Footprint } from './footprints'
import { crispTextImage } from './streets'

// ---------------------------------------------------------------------------
// Module 4 — hazard geometry layers:
//  · WIND: a vector arrow at the incident showing live NWS wind (points
//    DOWNWIND), with speed/gust/direction/station label; for Hazmat
//    incidents, a dashed downwind isolation wedge suggestion (EST.).
//  · COLLAPSE: per-face collapse zones extruded outward from every footprint
//    edge at multiplier × roof height (default 1.5× — VALIDATE—SME).
// ---------------------------------------------------------------------------

/** Default collapse-zone multiplier of building height — VALIDATE—SME. */
export const COLLAPSE_MULTIPLIER = 1.5

const COLLAPSE_FILL = lazy(() => Cesium.Color.fromCssColorString('#f87171').withAlpha(0.2))
const COLLAPSE_EDGE = lazy(() => Cesium.Color.fromCssColorString('#f87171').withAlpha(0.75))
const WIND_COLOR = lazy(() => Cesium.Color.fromCssColorString('#38bdf8'))

const M_PER_DEG_LAT = 111_320

export class HazardLayer {
  private source = new Cesium.CustomDataSource('hazards')
  private windVisible = true
  private collapseVisible = true

  constructor(viewer: Cesium.Viewer) {
    void viewer.dataSources.add(this.source)
  }

  /** Live wind vector at the incident. Arrow points DOWNWIND. */
  renderWind(lat: number, lon: number, wind: WindObs, hazmat: boolean): void {
    this.clearWind()
    const toDeg = (wind.fromDeg + 180) % 360
    const rad = (toDeg * Math.PI) / 180
    const cosLat = Math.cos((lat * Math.PI) / 180)
    const lenM = 140
    const tip: [number, number] = [
      lon + (Math.sin(rad) * lenM) / (M_PER_DEG_LAT * cosLat),
      lat + (Math.cos(rad) * lenM) / M_PER_DEG_LAT,
    ]
    const base: [number, number] = [
      lon - (Math.sin(rad) * lenM * 0.4) / (M_PER_DEG_LAT * cosLat),
      lat - (Math.cos(rad) * lenM * 0.4) / M_PER_DEG_LAT,
    ]
    this.source.entities.add({
      id: 'wind:shaft',
      show: this.windVisible,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArray([...base, ...tip]),
        width: 5,
        material: new Cesium.PolylineArrowMaterialProperty(WIND_COLOR()),
        clampToGround: true,
      },
    })
    const gust = wind.gustKt ? ` G${wind.gustKt}` : ''
    this.source.entities.add({
      id: 'wind:label',
      show: this.windVisible,
      position: Cesium.Cartesian3.fromDegrees(base[0], base[1], 0),
      billboard: {
        image: crispTextImage(`WIND ${wind.speedKt} KT${gust} FROM ${wind.fromDeg}° · ${wind.stationId}`, '#7dd3fc', 22),
        scale: 0.5,
        heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        pixelOffset: new Cesium.Cartesian2(0, 18),
      },
    })
    if (hazmat) {
      // Suggested downwind isolation wedge (60° arc, 500 m) — an ESTIMATE to
      // prompt the IC, not a plume model.
      const wedge: number[] = [lon, lat]
      for (let a = -30; a <= 30; a += 10) {
        const r = ((toDeg + a) * Math.PI) / 180
        wedge.push(
          lon + (Math.sin(r) * 500) / (M_PER_DEG_LAT * cosLat),
          lat + (Math.cos(r) * 500) / M_PER_DEG_LAT,
        )
      }
      this.source.entities.add({
        id: 'wind:wedge',
        show: this.windVisible,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArray([...wedge, lon, lat]),
          width: 2.5,
          material: new Cesium.PolylineDashMaterialProperty({ color: WIND_COLOR().withAlpha(0.8), dashLength: 14 }),
          clampToGround: true,
        },
      })
      this.source.entities.add({
        id: 'wind:wedge-label',
        show: this.windVisible,
        position: Cesium.Cartesian3.fromDegrees(
          lon + (Math.sin(rad) * 260) / (M_PER_DEG_LAT * cosLat),
          lat + (Math.cos(rad) * 260) / M_PER_DEG_LAT,
          0,
        ),
        billboard: {
          image: crispTextImage('SUGGESTED DOWNWIND ISOLATION (EST.) — VALIDATE—SME', '#7dd3fc', 19),
          scale: 0.5,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      })
    }
  }

  /**
   * Per-face collapse zones: every outer-ring edge of every footprint part
   * gets an outward quad at multiplier × roof height.
   */
  renderCollapse(target: Footprint, heightM: number, multiplier = COLLAPSE_MULTIPLIER): void {
    this.clearCollapse()
    const d = Math.max(5, heightM * multiplier)
    let labelPlaced = false
    for (let p = 0; p < target.polygons.length; p++) {
      const outer = target.polygons[p][0]
      if (!outer || outer.length < 3) continue
      // Signed area sign tells the winding so the normal points OUTWARD.
      let area = 0
      const n = outer[0][0] === outer[outer.length - 1][0] && outer[0][1] === outer[outer.length - 1][1]
        ? outer.length - 1
        : outer.length
      for (let i = 0; i < n; i++) {
        const [x1, y1] = outer[i]
        const [x2, y2] = outer[(i + 1) % n]
        area += x1 * y2 - x2 * y1
      }
      const ccw = area > 0
      const midLat = outer[0][1]
      const cosLat = Math.cos((midLat * Math.PI) / 180)
      for (let i = 0; i < n; i++) {
        const [ax, ay] = outer[i]
        const [bx, by] = outer[(i + 1) % n]
        const exM = (bx - ax) * M_PER_DEG_LAT * cosLat
        const eyM = (by - ay) * M_PER_DEG_LAT
        const len = Math.hypot(exM, eyM)
        if (len < 2) continue
        // Outward normal (CCW ring -> right side of the edge is outside).
        const s = ccw ? 1 : -1
        const nx = (s * eyM) / len
        const ny = (-s * exM) / len
        const dLon = (nx * d) / (M_PER_DEG_LAT * cosLat)
        const dLat = (ny * d) / M_PER_DEG_LAT
        this.source.entities.add({
          id: `collapse:${p}:${i}`,
          show: this.collapseVisible,
          polygon: {
            hierarchy: new Cesium.PolygonHierarchy(
              Cesium.Cartesian3.fromDegreesArray([ax, ay, bx, by, bx + dLon, by + dLat, ax + dLon, ay + dLat]),
            ),
            material: COLLAPSE_FILL(),
            outline: true,
            outlineColor: COLLAPSE_EDGE(),
            classificationType: Cesium.ClassificationType.BOTH,
          },
        })
        if (!labelPlaced && len > 20) {
          labelPlaced = true
          this.source.entities.add({
            id: 'collapse:label',
            show: this.collapseVisible,
            position: Cesium.Cartesian3.fromDegrees((ax + bx) / 2 + dLon, (ay + by) / 2 + dLat, 0),
            billboard: {
              image: crispTextImage(`COLLAPSE ZONE ${multiplier}×H (${Math.round(d)} m) — VALIDATE—SME`, '#fca5a5', 20),
              scale: 0.5,
              heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          })
        }
      }
    }
  }

  setWindVisible(show: boolean): void {
    this.windVisible = show
    for (const e of this.source.entities.values) if (e.id.startsWith('wind:')) e.show = show
  }

  setCollapseVisible(show: boolean): void {
    this.collapseVisible = show
    for (const e of this.source.entities.values) if (e.id.startsWith('collapse:')) e.show = show
  }

  clearWind(): void {
    for (const e of [...this.source.entities.values]) if (e.id.startsWith('wind:')) this.source.entities.remove(e)
  }

  clearCollapse(): void {
    for (const e of [...this.source.entities.values]) if (e.id.startsWith('collapse:')) this.source.entities.remove(e)
  }

  clear(): void {
    this.source.entities.removeAll()
  }
}
