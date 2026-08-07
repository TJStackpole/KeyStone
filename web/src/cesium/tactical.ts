import * as Cesium from 'cesium'
import { lazy } from './lazy'
import { pointInRing } from '../lib/geo'
import type { Footprint } from './footprints'
import { crispTextImage } from './streets'

// ---------------------------------------------------------------------------
// ISOLATE tactical model: wraps the isolated (lifted) fire building in its
// structural skeleton so crews can read what they're walking into —
//   · a floor ring per storey (real PLUTO floor count spanning the real
//     building height), the FIRE floor in red
//   · vertical column lines at the footprint's corners
//   · FL numbering on the entrance face
//   · MAIN ENTRANCE at the footprint edge nearest the address point (real
//     PAD address data); other faces get EGRESS (EST.) marks — estimated,
//     and labeled as such per the no-silent-simulation rule.
// ---------------------------------------------------------------------------

const GRID = lazy(() => Cesium.Color.fromCssColorString('#22d3ee'))
const FIRE = lazy(() => Cesium.Color.fromCssColorString('#ef4444'))
const ENTRANCE = lazy(() => Cesium.Color.fromCssColorString('#22c55e'))
const EGRESS = lazy(() => Cesium.Color.fromCssColorString('#f59e0b'))
const LABEL_BG = lazy(() => Cesium.Color.fromCssColorString('#0a0e14').withAlpha(0.78))
const FOCUS = lazy(() => Cesium.Color.fromCssColorString('#22d3ee'))
const VOLUME_FILL = lazy(() => GRID().withAlpha(0.1))
const SLAB_FILL = lazy(() => Cesium.Color.fromCssColorString('#7dd3fc').withAlpha(0.28))
const FIRE_SLAB_FILL = lazy(() => FIRE().withAlpha(0.45))
const CORE_FILL = lazy(() => EGRESS().withAlpha(0.55))

const MAX_RINGS = 40 // towers get a ring every Nth storey, labels follow

export interface TacticalModelOpts {
  base: number
  lift: number
  heightM: number
  floors: number
  fireFloor?: number
  /** Address point — the main entrance sits on the nearest footprint edge. */
  address: { lat: number; lon: number }
  /**
   * 'model': full schematic — glass volume, floor slabs, estimated stair
   * core — replacing the (patchy when clipped) real imagery. 'live': just the
   * wireframe/marks over the real building.
   */
  view: 'model' | 'live'
  /**
   * Vertical exaggeration (MODEL view only) — stretches every storey so
   * interior tracking reads at a glance. Real dimensions stay in the header,
   * and the scale is labeled on the model per the no-silent-simulation rule.
   */
  scale?: number
}

/** Closest point on the ring (lon/lat pairs) to `p`, plus that edge's index and squared distance. */
function closestOnRing(
  ring: number[][],
  p: { lat: number; lon: number },
): { lat: number; lon: number; edge: number; d2: number } {
  const cosLat = Math.cos((p.lat * Math.PI) / 180)
  let best = { lat: ring[0][1], lon: ring[0][0], edge: 0, d2: Infinity }
  for (let i = 0; i < ring.length - 1; i++) {
    const [ax, ay] = ring[i]
    const [bx, by] = ring[i + 1]
    const abx = (bx - ax) * cosLat
    const aby = by - ay
    const apx = (p.lon - ax) * cosLat
    const apy = p.lat - ay
    const len2 = abx * abx + aby * aby || 1e-12
    const t = Math.max(0, Math.min(1, (apx * abx + apy * aby) / len2))
    const cx = ax + ((bx - ax) * t)
    const cy = ay + (by - ay) * t
    const dx = (p.lon - cx) * cosLat
    const dy = p.lat - cy
    const d2 = dx * dx + dy * dy
    if (d2 < best.d2) best = { lat: cy, lon: cx, edge: i, d2 }
  }
  return best
}

export class TacticalModelLayer {
  private source = new Cesium.CustomDataSource('tactical-model')
  /** Geometry of the last show() — the focus band re-anchors to it. */
  private lastGeom: { ring: number[][]; z0: number; storey: number; floors: number } | null = null

  constructor(viewer: Cesium.Viewer) {
    void viewer.dataSources.add(this.source)
  }

  show(target: Footprint, opts: TacticalModelOpts): void {
    this.clear()
    // Multi-part footprints (bridged wings, complexes): the clip isolates
    // EVERY part, so wrap the part the address actually fronts — the one
    // containing the geocoded point, else the one with the nearest edge
    // (PAD points often sit on the sidewalk just outside every ring).
    const rings = target.polygons.map((poly) => poly[0]).filter((r) => r && r.length >= 3)
    if (!rings.length) return
    let outer = rings.find((r) => pointInRing(opts.address.lon, opts.address.lat, r))
    if (!outer) {
      let bestD2 = Infinity
      for (const r of rings) {
        const c = closestOnRing(r, opts.address)
        if (c.d2 < bestD2) {
          bestD2 = c.d2
          outer = r
        }
      }
    }
    if (!outer) return
    const last = outer[outer.length - 1]
    const closed = outer[0][0] === last[0] && outer[0][1] === last[1]
    const ring = closed ? outer : [...outer, outer[0]]
    const z0 = opts.base + opts.lift
    const floors = Math.max(1, Math.round(opts.floors))
    const scale = Math.max(1, opts.scale ?? 1)
    const hEff = opts.heightM * scale
    const storey = hEff / floors
    const step = Math.max(1, Math.ceil(floors / MAX_RINGS))

    const entrance = closestOnRing(ring, opts.address)
    this.lastGeom = { ring, z0, storey, floors }

    // MODEL view: clean schematic replaces the (patchy when clipped) real
    // imagery — glass volume per wing, floor slabs, estimated stair core.
    if (opts.view === 'model') {
      this.buildModel(target, ring, opts, z0, floors, storey, step, entrance, hEff)
    }

    // Floor rings (fire floor always drawn, in red).
    for (let f = 0; f <= floors; f += 1) {
      const isFire = opts.fireFloor !== undefined && f === opts.fireFloor
      if (f % step !== 0 && f !== floors && !isFire) continue
      const z = z0 + f * storey
      this.source.entities.add({
        id: `tact:ring:${f}`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(ring.flatMap(([lon, lat]) => [lon, lat, z])),
          width: isFire ? 4 : 1.6,
          material: isFire
            ? new Cesium.PolylineGlowMaterialProperty({ color: FIRE(), glowPower: 0.35 })
            : GRID().withAlpha(0.55),
        },
      })
      // Storey number on the entrance face (skip the roof ring's duplicate).
      if (f >= 1 && f <= floors) {
        this.source.entities.add({
          id: `tact:fl:${f}`,
          position: Cesium.Cartesian3.fromDegrees(entrance.lon, entrance.lat, z - storey / 2),
          billboard: {
            image: crispTextImage(isFire ? `FL ${f} · FIRE` : `FL ${f}`, isFire ? '#fca5a5' : '#a5f3fc', 20),
            scale: 0.5,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            scaleByDistance: new Cesium.NearFarScalar(150, 1, 2500, 0.4),
          },
        })
      }
    }

    // Column lines at footprint corners.
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon, lat] = ring[i]
      this.source.entities.add({
        id: `tact:col:${i}`,
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights([lon, lat, z0, lon, lat, z0 + hEff]),
          width: 1.2,
          material: GRID().withAlpha(0.35),
        },
      })
    }

    // Main entrance — nearest footprint edge to the geocoded address point.
    this.source.entities.add({
      id: 'tact:entrance',
      position: Cesium.Cartesian3.fromDegrees(entrance.lon, entrance.lat, z0 + 1.2),
      billboard: {
        image: crispTextImage('▶ MAIN ENTRANCE', '#4ade80', 22),
        scale: 0.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      point: { pixelSize: 10, color: ENTRANCE(), outlineColor: Cesium.Color.BLACK, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    })

    // Estimated egress on the other bbox faces (clearly labeled EST.).
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
    for (const [lon, lat] of ring) {
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon)
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
    }
    const faces: { lat: number; lon: number }[] = [
      { lat: maxLat, lon: (minLon + maxLon) / 2 },
      { lat: minLat, lon: (minLon + maxLon) / 2 },
      { lat: (minLat + maxLat) / 2, lon: minLon },
      { lat: (minLat + maxLat) / 2, lon: maxLon },
    ]
    let n = 0
    for (const face of faces) {
      const onRing = closestOnRing(ring, face)
      const cosLat = Math.cos((onRing.lat * Math.PI) / 180)
      const dLon = (onRing.lon - entrance.lon) * cosLat
      const dLat = onRing.lat - entrance.lat
      if (Math.sqrt(dLon * dLon + dLat * dLat) * 111_320 < 12) continue // that's the entrance
      n++
      this.source.entities.add({
        id: `tact:egress:${n}`,
        position: Cesium.Cartesian3.fromDegrees(onRing.lon, onRing.lat, z0 + 1.2),
        billboard: {
          image: crispTextImage(`EGRESS ${n} (EST.)`, '#fbbf24', 18),
          scale: 0.5,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(150, 1, 2500, 0.5),
        },
        point: { pixelSize: 7, color: EGRESS(), outlineColor: Cesium.Color.BLACK, outlineWidth: 1.5, disableDepthTestDistance: Number.POSITIVE_INFINITY },
      })
    }

    // Header floating over the roof. Real dimensions always — the scale
    // stretches the model, so it's declared right next to the true height.
    this.source.entities.add({
      id: 'tact:head',
      position: Cesium.Cartesian3.fromDegrees(
        (minLon + maxLon) / 2,
        (minLat + maxLat) / 2,
        z0 + hEff + Math.max(8, hEff * 0.12),
      ),
      label: {
        text: `${floors} FLOORS · ${Math.round(opts.heightM)} m${opts.fireFloor ? ` · FIRE FL ${opts.fireFloor}` : ''}${scale > 1 ? ` · ×${scale} VERT SCALE` : ''}`,
        font: `700 13px 'JetBrains Mono', monospace`,
        fillColor: Cesium.Color.fromCssColorString('#e2ecf7'),
        showBackground: true,
        backgroundColor: LABEL_BG(),
        backgroundPadding: new Cesium.Cartesian2(8, 4),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    })
  }

  /**
   * Schematic building from REAL data (footprint rings, measured height,
   * PLUTO floor count): translucent volume for every wing, a slab per storey
   * (fire floor red), and a stair core. NYC publishes no stairwell layouts,
   * so the core is placed at the wing's centroid, oriented to its longest
   * wall, and labeled (EST.) per the no-silent-simulation rule.
   */
  private buildModel(
    target: Footprint,
    ring: number[][],
    opts: TacticalModelOpts,
    z0: number,
    floors: number,
    storey: number,
    step: number,
    entrance: { lat: number; lon: number },
    hEff: number,
  ): void {
    // Glass volume for EVERY part of the footprint (multi-wing complexes).
    for (let i = 0; i < target.polygons.length; i++) {
      const outer = target.polygons[i][0]
      if (!outer || outer.length < 3) continue
      this.source.entities.add({
        id: `tact:vol:${i}`,
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(outer.flat())),
          height: z0,
          extrudedHeight: z0 + hEff,
          material: VOLUME_FILL(),
          outline: true,
          outlineColor: GRID().withAlpha(0.5),
        },
      })
    }

    // Floor slabs on the entrance wing (towers keep the same ring stepping).
    const slabHierarchy = new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(ring.flat()))
    for (let f = 1; f < floors; f++) {
      const isFire = opts.fireFloor !== undefined && f === opts.fireFloor
      if (f % step !== 0 && !isFire) continue
      const z = z0 + f * storey
      this.source.entities.add({
        id: `tact:slab:${f}`,
        polygon: {
          hierarchy: slabHierarchy,
          height: z - 0.12,
          extrudedHeight: z + 0.12,
          material: isFire ? FIRE_SLAB_FILL() : SLAB_FILL(),
        },
      })
    }

    // Estimated stair core, oriented to the wing's longest wall. A vertex
    // average is NOT guaranteed inside a concave (L/U-shaped) wing, so walk
    // candidates from the average toward the entrance until the whole shaft
    // fits inside the ring — and draw nothing rather than something wrong.
    let avgLon = 0, avgLat = 0
    const n = ring.length - 1 // ring is closed
    for (let i = 0; i < n; i++) {
      avgLon += ring[i][0]
      avgLat += ring[i][1]
    }
    avgLon /= n
    avgLat /= n
    const cosLat = Math.cos((avgLat * Math.PI) / 180)
    let bestLen = 0
    let wallBearing = 0
    for (let i = 0; i < ring.length - 1; i++) {
      const dx = (ring[i + 1][0] - ring[i][0]) * cosLat
      const dy = ring[i + 1][1] - ring[i][1]
      const len = dx * dx + dy * dy
      if (len > bestLen) {
        bestLen = len
        wallBearing = Math.atan2(dx, dy)
      }
    }
    const along = { x: Math.sin(wallBearing), y: Math.cos(wallBearing) } // unit, meters
    const across = { x: Math.cos(wallBearing), y: -Math.sin(wallBearing) }
    const cornersAt = (cx: number, cy: number, halfL: number, halfW: number): [number, number][] =>
      (
        [
          [halfL, halfW],
          [halfL, -halfW],
          [-halfL, -halfW],
          [-halfL, halfW],
        ] as const
      ).map(([a, c]) => {
        const mx = a * along.x + c * across.x
        const my = a * along.y + c * across.y
        return [cx + mx / (111_320 * cosLat), cy + my / 111_320]
      })
    const shaftFits = (cx: number, cy: number, halfL: number, halfW: number): boolean =>
      pointInRing(cx, cy, ring) && cornersAt(cx, cy, halfL, halfW).every(([x, y]) => pointInRing(x, y, ring))
    // Candidate centers: the average, then points sliding from it toward the
    // entrance (concave wings usually have interior mass on that side).
    let core: { lon: number; lat: number; halfL: number; halfW: number } | null = null
    outer: for (const [halfL, halfW] of [
      [3.2, 2.2],
      [1.8, 1.3], // narrow-wing fallback shaft
    ] as const) {
      for (const t of [0, 0.25, 0.45, 0.65, 0.85]) {
        const cx = avgLon + (entrance.lon - avgLon) * t
        const cy = avgLat + (entrance.lat - avgLat) * t
        if (shaftFits(cx, cy, halfL, halfW)) {
          core = { lon: cx, lat: cy, halfL, halfW }
          break outer
        }
      }
    }
    if (!core) return // no honest placement — omit rather than mislead
    const coreRing = cornersAt(core.lon, core.lat, core.halfL, core.halfW)
    this.source.entities.add({
      id: 'tact:core',
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(coreRing.flat())),
        height: z0,
        extrudedHeight: z0 + hEff,
        material: CORE_FILL(),
        outline: true,
        outlineColor: EGRESS(),
      },
    })
    this.source.entities.add({
      id: 'tact:core:label',
      position: Cesium.Cartesian3.fromDegrees(core.lon, core.lat, z0 + hEff * 0.55),
      billboard: {
        image: crispTextImage('STAIRS (EST.)', '#fbbf24', 20),
        scale: 0.5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        scaleByDistance: new Cesium.NearFarScalar(150, 1, 2500, 0.5),
      },
    })
  }

  /**
   * Battle-view floor tracking: wrap a bright band around ONE storey — the
   * floor the operator is scrolling through in a locked facade view — so
   * the tracked floor pops out of the schematic at a glance. null clears.
   */
  setFocusFloor(floor: number | null): void {
    this.source.entities.removeById('tact:focus')
    const g = this.lastGeom
    if (floor === null || !g) return
    const f = Math.max(1, Math.min(g.floors, Math.round(floor)))
    this.source.entities.add({
      id: 'tact:focus',
      polygon: {
        hierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(g.ring.flat())),
        height: g.z0 + (f - 1) * g.storey,
        extrudedHeight: g.z0 + f * g.storey,
        material: FOCUS().withAlpha(0.22),
        outline: true,
        outlineColor: FOCUS().withAlpha(0.9),
      },
    })
  }

  clear(): void {
    this.source.entities.removeAll()
    this.lastGeom = null
  }
}
