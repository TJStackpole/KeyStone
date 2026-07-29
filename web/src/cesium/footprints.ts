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

const TARGET_FILL = Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.78)
const TARGET_OUTLINE = Cesium.Color.fromCssColorString('#fbbf24')
const NEIGHBOR_FILL = Cesium.Color.fromCssColorString('#334155').withAlpha(0.5)

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
  private viewer: Cesium.Viewer
  private visible = true

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer
  }

  clear(): void {
    for (const p of this.primitives) this.viewer.scene.primitives.remove(p)
    this.primitives = []
  }

  setVisible(show: boolean): void {
    this.visible = show
    for (const p of this.primitives) p.show = show
  }

  /**
   * @param extrudeNeighbors false when an upgraded provider already renders buildings —
   *        then only the target footprint highlight is drawn.
   */
  render(feats: Footprint[], targetBin: string | undefined, extrudeNeighbors: boolean): void {
    this.clear()
    const fillInstances: Cesium.GeometryInstance[] = []
    const outlineInstances: Cesium.GeometryInstance[] = []

    for (const f of feats) {
      const isTarget = targetBin !== undefined && f.bin === targetBin
      if (!isTarget && !extrudeNeighbors) continue
      for (let i = 0; i < f.polygons.length; i++) {
        const hierarchy = ringToHierarchy(f.polygons[i])
        fillInstances.push(
          new Cesium.GeometryInstance({
            id: `footprint:${f.bin}:${i}`,
            geometry: new Cesium.PolygonGeometry({
              polygonHierarchy: hierarchy,
              height: 0,
              extrudedHeight: f.heightM,
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
                height: 0,
                extrudedHeight: f.heightM,
              }),
              attributes: {
                color: Cesium.ColorGeometryInstanceAttribute.fromColor(TARGET_OUTLINE),
              },
            }),
          )
        }
      }
    }

    if (fillInstances.length) {
      const fill = new Cesium.Primitive({
        geometryInstances: fillInstances,
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }),
        asynchronous: true,
      })
      fill.show = this.visible
      this.viewer.scene.primitives.add(fill)
      this.primitives.push(fill)
    }
    if (outlineInstances.length) {
      const outline = new Cesium.Primitive({
        geometryInstances: outlineInstances,
        appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: false }),
        asynchronous: true,
      })
      outline.show = this.visible
      this.viewer.scene.primitives.add(outline)
      this.primitives.push(outline)
    }
  }
}
