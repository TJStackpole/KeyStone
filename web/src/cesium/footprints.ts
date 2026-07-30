import * as Cesium from 'cesium'
import { maybeFailNyc } from '../lib/failNyc'
import { feetToMeters, pointInRing } from '../lib/geo'

export interface Footprint {
  bin: string
  heightM: number
  constructionYear?: number
  /** GeoJSON MultiPolygon coordinates: polygons -> rings -> [lon, lat] */
  polygons: number[][][][]
}

// Strong enough to read across the map, translucent enough to see the real
// building through it — and independently toggleable (Fire Bldg chip).
const TARGET_FILL = Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.45)
const TARGET_OUTLINE = Cesium.Color.fromCssColorString('#fbbf24')
const NEIGHBOR_FILL = Cesium.Color.fromCssColorString('#334155').withAlpha(0.28)

const SODA_FOOTPRINTS = 'https://data.cityofnewyork.us/resource/5zhs-2jue.json'

interface SodaFootprintRow {
  bin?: string
  height_roof?: string
  construction_year?: string
  the_geom?: { type: string; coordinates: number[][][][] }
}

/** Fetch NYC Building Footprints within `radiusM` of a point (SODA within_circle). */
export async function fetchFootprints(lat: number, lon: number, radiusM = 250): Promise<Footprint[]> {
  maybeFailNyc()
  const params = new URLSearchParams({
    $select: 'bin,height_roof,construction_year,the_geom',
    $where: `within_circle(the_geom, ${lat}, ${lon}, ${radiusM})`,
    $limit: '900',
  })
  const res = await fetch(`${SODA_FOOTPRINTS}?${params}`)
  if (!res.ok) throw new Error(`footprints SODA ${res.status}`)
  const rows = (await res.json()) as SodaFootprintRow[]
  return rows
    .filter((r) => r.the_geom?.type === 'MultiPolygon' && r.the_geom.coordinates?.length)
    .map((r) => ({
      bin: r.bin ?? 'unknown',
      // height_roof is FEET above ground in this dataset; missing -> assume ~3 stories.
      heightM: r.height_roof ? Math.max(3, feetToMeters(Number(r.height_roof))) : 10,
      constructionYear: r.construction_year ? Number(r.construction_year) : undefined,
      polygons: r.the_geom!.coordinates,
    }))
}

/** Find the footprint whose outer ring contains the geocoded point (fallback when BIN is absent). */
export function footprintContaining(lon: number, lat: number, feats: Footprint[]): Footprint | undefined {
  return feats.find((f) => f.polygons.some((poly) => pointInRing(lon, lat, poly[0])))
}

function ringToHierarchy(poly: number[][][]): Cesium.PolygonHierarchy {
  const [outer, ...holes] = poly
  return new Cesium.PolygonHierarchy(
    Cesium.Cartesian3.fromDegreesArray(outer.flat()),
    holes.map((h) => new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(h.flat()))),
  )
}

/**
 * Renders one incident's worth of extruded footprints as batched polygon primitives
 * (keyless-mode buildings), plus an amber highlight + glowing outline on the target.
 */
export class FootprintLayer {
  private primitives: Cesium.Primitive[] = []
  private targetPrimitives: Cesium.Primitive[] = []
  private viewer: Cesium.Viewer
  private visible = true
  private targetVisible = true
  private renderSeq = 0
  // Street level under the CURRENT target, sampled pre-clip. The isolate
  // tactical model needs this: once the clip is on, ring samples outside the
  // footprint hit the re-shown globe (ellipsoid 0), not the sunken streets.
  private targetBasePromise: Promise<number> = Promise.resolve(0)

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer
  }

  clear(): void {
    this.renderSeq++
    for (const p of this.primitives) this.viewer.scene.primitives.remove(p)
    this.primitives = []
    this.targetPrimitives = []
  }

  setVisible(show: boolean): void {
    this.visible = show
    this.applyVisibility()
  }

  /** Street-level height under the current target (resolves with the in-flight render). */
  targetBase(): Promise<number> {
    return this.targetBasePromise
  }

  /** Fire Bldg chip: the orange target box on its own switch. */
  setTargetVisible(show: boolean): void {
    this.targetVisible = show
    this.applyVisibility()
  }

  private applyVisibility(): void {
    for (const p of this.primitives) {
      const isTarget = this.targetPrimitives.includes(p)
      p.show = this.visible && (!isTarget || this.targetVisible)
    }
  }

  /**
   * Street level around a footprint, as height above ellipsoid. Sampling the
   * centroid would hit the photorealistic building's ROOF, so sample a ring
   * of points just outside the footprint and take the lowest — that's the
   * sidewalk. Falls back to 0 (keyless ellipsoid ground) when unsupported.
   */
  private async sampleGroundBase(f: Footprint): Promise<number> {
    const scene = this.viewer.scene
    if (!scene.sampleHeightSupported) return 0
    const outer = f.polygons[0]?.[0]
    if (!outer?.length) return 0
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity
    for (const [lon, lat] of outer) {
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon)
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat)
    }
    const cLon = (minLon + maxLon) / 2
    const cLat = (minLat + maxLat) / 2
    // Ring radius: half the bbox diagonal plus a sidewalk's width.
    const degPad = 8 / 111000
    const rLon = (maxLon - minLon) / 2 + degPad
    const rLat = (maxLat - minLat) / 2 + degPad
    const ring: Cesium.Cartographic[] = []
    for (let i = 0; i < 8; i++) {
      const th = (i / 8) * 2 * Math.PI
      ring.push(Cesium.Cartographic.fromDegrees(cLon + rLon * Math.sin(th), cLat + rLat * Math.cos(th)))
    }
    try {
      const sampled = await scene.sampleHeightMostDetailed(ring)
      const heights = sampled.map((c) => c?.height).filter((h): h is number => Number.isFinite(h))
      return heights.length ? Math.min(...heights) : 0
    } catch {
      return 0
    }
  }

  /**
   * @param extrudeNeighbors false when an upgraded provider already renders buildings —
   *        then only the target footprint highlight is drawn.
   */
  async render(feats: Footprint[], targetBin: string | undefined, extrudeNeighbors: boolean): Promise<void> {
    this.clear()
    const seq = this.renderSeq
    const neighborFillInstances: Cesium.GeometryInstance[] = []
    const targetFillInstances: Cesium.GeometryInstance[] = []
    const outlineInstances: Cesium.GeometryInstance[] = []

    // Base the target's box at true street level so low-rise highlights hug
    // the building instead of floating (geoid offset on photorealistic tiles).
    const target = targetBin !== undefined ? feats.find((f) => f.bin === targetBin) : undefined
    // Kick the sample and publish the promise synchronously — callers that
    // fire right after a void render() (isolate self-heal) await the same one.
    this.targetBasePromise = target ? this.sampleGroundBase(target) : Promise.resolve(0)
    const base = await this.targetBasePromise
    if (seq !== this.renderSeq) return // superseded by a newer render/clear

    for (const f of feats) {
      const isTarget = targetBin !== undefined && f.bin === targetBin
      if (!isTarget && !extrudeNeighbors) continue
      const h0 = isTarget ? base : 0
      for (let i = 0; i < f.polygons.length; i++) {
        const hierarchy = ringToHierarchy(f.polygons[i])
        ;(isTarget ? targetFillInstances : neighborFillInstances).push(
          new Cesium.GeometryInstance({
            id: `footprint:${f.bin}:${i}`,
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: hierarchy,
              height: h0,
              extrudedHeight: h0 + f.heightM,
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(isTarget ? TARGET_FILL : NEIGHBOR_FILL),
            },
          }),
        )
        if (isTarget) {
          outlineInstances.push(
            new Cesium.GeometryInstance({
              id: `footprint-outline:${f.bin}:${i}`,
              geometry: new Cesium.PolygonOutlineGeometry({
                polygonHierarchy: hierarchy,
                height: h0,
                extrudedHeight: h0 + f.heightM,
              }),
              attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(TARGET_OUTLINE),
              },
            }),
          )
        }
      }
    }

    if (neighborFillInstances.length) {
      const fill = new Cesium.Primitive({
        geometryInstances: neighborFillInstances,
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }),
        asynchronous: true,
      })
      this.viewer.scene.primitives.add(fill)
      this.primitives.push(fill)
    }
    // Target fill + outline live in their own primitives so the orange box
    // can be toggled independently of the neighbor extrusions (Fire Bldg chip).
    if (targetFillInstances.length) {
      const fill = new Cesium.Primitive({
        geometryInstances: targetFillInstances,
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }),
        asynchronous: true,
      })
      this.viewer.scene.primitives.add(fill)
      this.primitives.push(fill)
      this.targetPrimitives.push(fill)
    }
    if (outlineInstances.length) {
      const outline = new Cesium.Primitive({
        geometryInstances: outlineInstances,
        appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: false }),
        asynchronous: true,
      })
      this.viewer.scene.primitives.add(outline)
      this.primitives.push(outline)
      this.targetPrimitives.push(outline)
    }
    this.applyVisibility()
  }
}
