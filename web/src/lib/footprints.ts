import { feetToMeters, pointInRing } from './geo'
import { maybeFailNyc } from './failNyc'

// ---------------------------------------------------------------------------
// NYC Building Footprints — fetch + geometry types, RENDERER-NEUTRAL (Prompt
// 14). Both the legacy 3D layer (cesium/footprints re-exports these) and the
// 2D tactical map consume this module; it must never import cesium, or the
// 2D bundle drags the whole engine back in.
// ---------------------------------------------------------------------------

export interface Footprint {
  bin: string
  heightM: number
  constructionYear?: number
  /** GeoJSON MultiPolygon coordinates: polygons -> rings -> [lon, lat] */
  polygons: number[][][][]
}

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
