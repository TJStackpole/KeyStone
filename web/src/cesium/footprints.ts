import * as Cesium from 'cesium'
import { fetchFootprints, footprintContaining, type Footprint } from '../lib/footprints'

// Fetch + geometry moved to lib/footprints (renderer-neutral, Prompt 14);
// this module keeps only the 3D rendering half and re-exports the rest so
// existing imports keep working.
export { fetchFootprints, footprintContaining, type Footprint }

// Strong enough to read across the map, translucent enough to see the real
// building through it — and independently toggleable (Fire Bldg chip).
const TARGET_FILL = Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.45)
const TARGET_OUTLINE = Cesium.Color.fromCssColorString('#fbbf24')
const NEIGHBOR_FILL = Cesium.Color.fromCssColorString('#334155').withAlpha(0.28)

function ringToHierarchy(poly: number[][][]): Cesium.PolygonHierarchy {
  const [outer, ...holes] = poly
  return new Cesium.PolygonHierarchy(
    Cesium.Cartesian3.fromDegreesArray(outer.flat()),
    holes.map((h) => new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(h.flat()))),
  )
}

/**
 * Street level around a footprint, as height above ellipsoid. Sampling the
 * centroid would hit the photorealistic building's ROOF, so sample a ring
 * of points just outside the footprint and take the lowest — that's the
 * sidewalk. Falls back to 0 (keyless ellipsoid ground) when unsupported.
 * Exported for the tapped-building schematic, which has no incident render
 * to piggyback on.
 */
export async function sampleStreetBase(scene: Cesium.Scene, f: Footprint): Promise<number> {
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

  private sampleGroundBase(f: Footprint): Promise<number> {
    return sampleStreetBase(this.viewer.scene, f)
  }

  /**
   * @param extrudeNeighbors false when an upgraded provider already renders buildings —
   *        then only the target footprint highlight is drawn.
   *
   * Two-stage: the neighbor extrusions (which always base at 0) go up
   * IMMEDIATELY; only the target's fill/outline waits for the street-level
   * sample — on photorealistic tiles that sample streams max-detail tiles and
   * can take seconds, and it must not gate the whole keyless cityscape.
   */
  async render(feats: Footprint[], targetBin: string | undefined, extrudeNeighbors: boolean): Promise<void> {
    this.clear()
    const seq = this.renderSeq

    // Base the target's box at true street level so low-rise highlights hug
    // the building instead of floating (geoid offset on photorealistic tiles).
    const target = targetBin !== undefined ? feats.find((f) => f.bin === targetBin) : undefined
    // Kick the sample and publish the promise synchronously — callers that
    // fire right after a void render() (isolate self-heal) await the same one.
    this.targetBasePromise = target ? this.sampleGroundBase(target) : Promise.resolve(0)

    if (extrudeNeighbors) {
      const neighborFillInstances: Cesium.GeometryInstance[] = []
      for (const f of feats) {
        if (targetBin !== undefined && f.bin === targetBin) continue
        for (let i = 0; i < f.polygons.length; i++) {
          neighborFillInstances.push(
            new Cesium.GeometryInstance({
              id: `footprint:${f.bin}:${i}`,
              geometry: new Cesium.PolygonGeometry({
                polygonHierarchy: ringToHierarchy(f.polygons[i]),
                height: 0,
                extrudedHeight: f.heightM,
                vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
              }),
              attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(NEIGHBOR_FILL) },
            }),
          )
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
      this.applyVisibility()
    }

    if (!target) return
    const base = await this.targetBasePromise
    if (seq !== this.renderSeq) return // superseded by a newer render/clear

    const targetFillInstances: Cesium.GeometryInstance[] = []
    const outlineInstances: Cesium.GeometryInstance[] = []
    for (let i = 0; i < target.polygons.length; i++) {
      const hierarchy = ringToHierarchy(target.polygons[i])
      targetFillInstances.push(
        new Cesium.GeometryInstance({
          id: `footprint:${target.bin}:${i}`,
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: hierarchy,
            height: base,
            extrudedHeight: base + target.heightM,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(TARGET_FILL) },
        }),
      )
      outlineInstances.push(
        new Cesium.GeometryInstance({
          id: `footprint-outline:${target.bin}:${i}`,
          geometry: new Cesium.PolygonOutlineGeometry({
            polygonHierarchy: hierarchy,
            height: base,
            extrudedHeight: base + target.heightM,
          }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(TARGET_OUTLINE) },
        }),
      )
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
