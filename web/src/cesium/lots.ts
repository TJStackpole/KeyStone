import * as Cesium from 'cesium'
import { lazy } from './lazy'
import type { TaxLot } from '../api/nyc'
import { pointInRing } from '../lib/geo'

// ---------------------------------------------------------------------------
// Tax-lot borders (DOF Digital Tax Map): every lot near the camera gets its
// boundary draped over the scene, and lotAt() answers "which lot did the
// operator click inside?" so the click resolves that lot's own address.
// One batched GroundPolylinePrimitive per fetch — thousands of entity
// polylines would rebuild shadow volumes per lot and crawl.
// ---------------------------------------------------------------------------

const LOT_LINE = lazy(() => Cesium.Color.fromCssColorString('#22d3ee').withAlpha(0.4))

// Instance construction (sanitize + degrees->Cartesian per ring) is the
// main-thread cost of a refresh — ~1k lots per fetch in Lower Manhattan used
// to run as one burst (tens to ~200 ms) right as the camera settled and tile
// streaming peaked. Chunked across frames it never blocks a frame for long.
const LOTS_PER_FRAME = 200

/**
 * Dedupe + de-spike a DTM lot ring for GroundPolylineGeometry. Survey data
 * contains exact-duplicate vertices AND A->B->A reversal spikes; either makes
 * Cesium's miter-normal math normalize a zero vector, and ONE bad vertex in
 * ONE lot kills the entire render loop. Returns an open [lon,lat,...] array
 * (loop:true closes it), or null when fewer than 3 sound vertices remain.
 */
function sanitizeRing(outer: number[][]): number[] | null {
  const pts: [number, number][] = outer.map(([x, y]) => [x, y])
  const near = (a: [number, number], b: [number, number]) =>
    Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9
  let changed = true
  while (changed && pts.length >= 3) {
    changed = false
    // Consecutive duplicates, wrap-aware (covers the ring's closing repeat).
    for (let i = pts.length - 1; i >= 0 && pts.length >= 3; i--) {
      if (near(pts[i], pts[(i + 1) % pts.length])) {
        pts.splice(i, 1)
        changed = true
      }
    }
    // Reversal spikes: interior angle ~180deg with opposing directions.
    for (let i = pts.length - 1; i >= 0 && pts.length >= 3; i--) {
      const a = pts[(i - 1 + pts.length) % pts.length]
      const b = pts[i]
      const c = pts[(i + 1) % pts.length]
      const ux = b[0] - a[0], uy = b[1] - a[1]
      const vx = c[0] - b[0], vy = c[1] - b[1]
      const cross = ux * vy - uy * vx
      const dot = ux * vx + uy * vy
      const scale = (ux * ux + uy * uy) * (vx * vx + vy * vy)
      if (scale > 0 && (cross * cross) / scale < 1e-12 && dot < 0) {
        pts.splice(i, 1)
        changed = true
      }
    }
  }
  if (pts.length < 3) return null
  return pts.flat()
}

export class LotLayer {
  private viewer: Cesium.Viewer
  private primitive: Cesium.GroundPolylinePrimitive | null = null
  private lots: TaxLot[] = []
  /** BBLs behind the current primitive — refetches that add nothing skip. */
  private renderedBbls = new Set<string>()
  private visible = true
  private renderSeq = 0

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer
  }

  render(lots: TaxLot[]): void {
    const seq = ++this.renderSeq
    // Empty result (screen center drifted over water / out of the city):
    // KEEP the grid that's still on screen — wiping it would also kill the
    // click hit-test for lots the operator can plainly see.
    if (!lots.length) return
    // Settle-triggered refetches overlap heavily (zoom-in, short pans): when
    // every fetched lot is already drawn, the primitive — and the richer
    // hit-test list behind it — is strictly a superset. Keep both.
    if (this.primitive && lots.every((l) => this.renderedBbls.has(l.bbl))) return

    const instances: Cesium.GeometryInstance[] = []
    let i = 0
    const step = (): void => {
      // A newer render()/clear() superseded this build — abandon it.
      if (seq !== this.renderSeq) return
      const end = Math.min(i + LOTS_PER_FRAME, lots.length)
      for (; i < end; i++) {
        const lot = lots[i]
        for (let p = 0; p < lot.polygons.length; p++) {
          const outer = lot.polygons[p][0]
          if (!outer || outer.length < 3) continue
          const pts = sanitizeRing(outer)
          if (!pts) continue
          instances.push(
            new Cesium.GeometryInstance({
              id: `lot:${lot.bbl}:${p}`,
              geometry: new Cesium.GroundPolylineGeometry({
                positions: Cesium.Cartesian3.fromDegreesArray(pts),
                width: 1.5,
                loop: true,
              }),
              attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(LOT_LINE()) },
            }),
          )
        }
      }
      if (i < lots.length) {
        requestAnimationFrame(step)
        return
      }
      // Swap only now — the old grid stays up (and hit-testable) while the
      // replacement builds, so a refresh never blanks the overlay.
      this.clearPrimitive()
      this.lots = lots
      this.renderedBbls = new Set(lots.map((l) => l.bbl))
      if (!instances.length) return
      this.primitive = new Cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PolylineColorAppearance(),
        asynchronous: true,
      })
      this.primitive.show = this.visible
      this.viewer.scene.groundPrimitives.add(this.primitive)
    }
    step()
  }

  /** The BBL of the lot whose border contains the point, if any is loaded. */
  lotAt(lon: number, lat: number): string | null {
    for (const lot of this.lots) {
      polygon: for (const poly of lot.polygons) {
        if (!poly[0] || !pointInRing(lon, lat, poly[0])) continue
        // Interior rings are HOLES — typically another lot enclosed by this
        // one (donut parcels). A point in the hole is NOT in this lot; keep
        // scanning so the enclosed lot (when loaded) wins deterministically.
        for (let r = 1; r < poly.length; r++) {
          if (poly[r] && pointInRing(lon, lat, poly[r])) continue polygon
        }
        return lot.bbl
      }
    }
    return null
  }

  setVisible(show: boolean): void {
    this.visible = show
    if (this.primitive) this.primitive.show = show
  }

  private clearPrimitive(): void {
    if (this.primitive) {
      this.viewer.scene.groundPrimitives.remove(this.primitive)
      this.primitive = null
    }
  }

  clear(): void {
    this.renderSeq++
    this.clearPrimitive()
    this.lots = []
    this.renderedBbls.clear()
  }
}
