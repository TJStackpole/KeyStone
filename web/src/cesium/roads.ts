import * as Cesium from 'cesium'
import type { RoadSegment } from '../api/nyc'
import { crispTextImage } from './streets'

// ---------------------------------------------------------------------------
// Road network + tunnels (OVERLAYS menu), from the NYC Street Centerline:
// yellow lines draped over every drivable street/highway/bridge/ramp near
// the camera, and the four major vehicular tunnels citywide (Lincoln,
// Holland, Queens-Midtown, Hugh L. Carey) in dashed amber with name labels.
// ---------------------------------------------------------------------------

const ROAD_YELLOW = Cesium.Color.fromCssColorString('#facc15')
const ROAD_LOCAL = ROAD_YELLOW.withAlpha(0.55)
const ROAD_MAJOR = ROAD_YELLOW.withAlpha(0.8)
const TUNNEL_AMBER = Cesium.Color.fromCssColorString('#fb923c')

/**
 * Dedupe + de-spike an open polyline: exact-duplicate consecutive vertices
 * and A->B->A reversals both make GroundPolylineGeometry's miter math
 * normalize a zero vector — one bad vertex kills the whole render loop
 * (learned the hard way with the tax-lot rings).
 */
function sanitizeLine(line: number[][]): number[] | null {
  const pts: [number, number][] = []
  for (const [x, y] of line) {
    const last = pts[pts.length - 1]
    if (last && Math.abs(x - last[0]) < 1e-9 && Math.abs(y - last[1]) < 1e-9) continue
    pts.push([x, y])
  }
  for (let i = pts.length - 2; i >= 1; i--) {
    const [ax, ay] = pts[i - 1]
    const [bx, by] = pts[i]
    const [cx, cy] = pts[i + 1]
    const ux = bx - ax, uy = by - ay
    const vx = cx - bx, vy = cy - by
    const cross = ux * vy - uy * vx
    const dot = ux * vx + uy * vy
    const scale = (ux * ux + uy * uy) * (vx * vx + vy * vy)
    if (scale > 0 && (cross * cross) / scale < 1e-12 && dot < 0) pts.splice(i, 1)
  }
  if (pts.length < 2) return null
  return pts.flat()
}

export class RoadLayer {
  private viewer: Cesium.Viewer
  private roadPrimitive: Cesium.GroundPolylinePrimitive | null = null
  private tunnelPrimitive: Cesium.GroundPolylinePrimitive | null = null
  private tunnelLabels = new Cesium.CustomDataSource('tunnel-labels')
  private roadsVisible = true
  private tunnelsVisible = true

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer
    void viewer.dataSources.add(this.tunnelLabels)
  }

  /** Replace the camera-local road network (yellow lines). */
  renderRoads(segments: RoadSegment[]): void {
    // Keep what's on screen when the view drifted somewhere road-less.
    if (!segments.length) return
    this.clearRoads()
    const instances: Cesium.GeometryInstance[] = []
    let i = 0
    for (const seg of segments) {
      for (const line of seg.lines) {
        const pts = sanitizeLine(line)
        if (!pts) continue
        instances.push(
          new Cesium.GeometryInstance({
            id: `road:${i++}`,
            geometry: new Cesium.GroundPolylineGeometry({
              positions: Cesium.Cartesian3.fromDegreesArray(pts),
              width: seg.major ? 4 : 2.2,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(seg.major ? ROAD_MAJOR : ROAD_LOCAL),
            },
          }),
        )
      }
    }
    if (!instances.length) return
    this.roadPrimitive = new Cesium.GroundPolylinePrimitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineColorAppearance(),
      asynchronous: true,
    })
    this.roadPrimitive.show = this.roadsVisible
    this.viewer.scene.groundPrimitives.add(this.roadPrimitive)
  }

  /** Render the citywide tunnel set once (dashed amber + name labels). */
  renderTunnels(segments: RoadSegment[]): void {
    this.clearTunnels()
    const instances: Cesium.GeometryInstance[] = []
    // One label per named tunnel, at the average of its segment midpoints.
    const named = new Map<string, { lat: number; lon: number; n: number }>()
    let i = 0
    for (const seg of segments) {
      for (const line of seg.lines) {
        const pts = sanitizeLine(line)
        if (!pts) continue
        instances.push(
          new Cesium.GeometryInstance({
            id: `tunnel:${i++}`,
            geometry: new Cesium.GroundPolylineGeometry({
              positions: Cesium.Cartesian3.fromDegreesArray(pts),
              width: 5,
            }),
            attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(TUNNEL_AMBER.withAlpha(0.85)) },
          }),
        )
        if (seg.name.includes('TUNL') || seg.name.includes('TUNNEL')) {
          const mid = Math.floor(pts.length / 4) * 2 // even index -> lon
          const agg = named.get(seg.name) ?? { lat: 0, lon: 0, n: 0 }
          agg.lon += pts[mid]
          agg.lat += pts[mid + 1]
          agg.n++
          named.set(seg.name, agg)
        }
      }
    }
    if (instances.length) {
      this.tunnelPrimitive = new Cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PolylineColorAppearance(),
        asynchronous: true,
      })
      this.tunnelPrimitive.show = this.tunnelsVisible
      this.viewer.scene.groundPrimitives.add(this.tunnelPrimitive)
    }
    for (const [name, agg] of named) {
      this.tunnelLabels.entities.add({
        id: `tunnel-label:${name}`,
        position: Cesium.Cartesian3.fromDegrees(agg.lon / agg.n, agg.lat / agg.n, 0),
        billboard: {
          image: crispTextImage(name, '#fdba74', 24),
          scale: 0.5,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(2000, 1, 40_000, 0.5),
        },
      })
    }
    this.tunnelLabels.show = this.tunnelsVisible
  }

  setRoadsVisible(show: boolean): void {
    this.roadsVisible = show
    if (this.roadPrimitive) this.roadPrimitive.show = show
  }

  setTunnelsVisible(show: boolean): void {
    this.tunnelsVisible = show
    if (this.tunnelPrimitive) this.tunnelPrimitive.show = show
    this.tunnelLabels.show = show
  }

  private clearRoads(): void {
    if (this.roadPrimitive) {
      this.viewer.scene.groundPrimitives.remove(this.roadPrimitive)
      this.roadPrimitive = null
    }
  }

  private clearTunnels(): void {
    if (this.tunnelPrimitive) {
      this.viewer.scene.groundPrimitives.remove(this.tunnelPrimitive)
      this.tunnelPrimitive = null
    }
    this.tunnelLabels.entities.removeAll()
  }

  clear(): void {
    this.clearRoads()
    this.clearTunnels()
  }
}
