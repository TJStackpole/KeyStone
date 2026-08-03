import { haversineMeters, Polyline, type PathPoint } from './lib/geo.js'

// FDNY Firehouse Listing (NYC Open Data, keyless) — the simulator dispatches
// the real nearest companies from their real houses.
const FIREHOUSES = 'https://data.cityofnewyork.us/resource/hc8x-tcnd.json'

// NYC Building Footprints (the same dataset the client extrudes) doubles as a
// keyless land mask: a point with no footprint within the probe radius is
// open water. Two radii, two questions — a spawn point must sit ON a block
// (75 m), while a route leg only needs to not be in the river: parks, plazas
// and bridge approaches carry roads but have no footprints for ~100 m, so
// route probes use 150 m. Mid-river points are ≥300 m from any footprint and
// still read wet.
const FOOTPRINTS = 'https://data.cityofnewyork.us/resource/5zhs-2jue.json'
const LAND_RADIUS_M = 75
const CORRIDOR_RADIUS_M = 150

const landCache = new Map<string, boolean>()

/**
 * Land mask for spawn points and route legs. An Open Data failure reads as
 * land so the simulator degrades to its old unvalidated behavior instead of
 * dead-ending the demo.
 */
export async function isLand(lat: number, lon: number, radiusM = LAND_RADIUS_M): Promise<boolean> {
  // ~11 m cells: repeated dispatches at the seed addresses (fixed bearings)
  // hit the cache without smearing the shoreline.
  const key = `${lat.toFixed(4)},${lon.toFixed(4)},${radiusM}`
  const cached = landCache.get(key)
  if (cached !== undefined) return cached
  try {
    const params = new URLSearchParams({
      $select: 'bin',
      $where: `within_circle(the_geom, ${lat}, ${lon}, ${radiusM})`,
      $limit: '1',
    })
    const res = await fetch(`${FOOTPRINTS}?${params}`, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`footprints SODA ${res.status}`)
    const rows = (await res.json()) as unknown[]
    const land = rows.length > 0
    landCache.set(key, land)
    return land
  } catch {
    return true
  }
}

/**
 * Sample a path every `stepM` and count points that fail the corridor land
 * mask. 0 means the path never crosses open water (the rivers are ~500-600 m
 * wide, so a 200 m step cannot hop one).
 */
export async function countWetSamples(points: PathPoint[], stepM = 200): Promise<number> {
  const line = new Polyline(points)
  const probes: Promise<boolean>[] = []
  for (let d = stepM / 2; d < line.totalM; d += stepM) {
    const { lat, lon } = line.at(d)
    probes.push(isLand(lat, lon, CORRIDOR_RADIUS_M))
  }
  const results = await Promise.all(probes)
  return results.filter((land) => !land).length
}

export interface Firehouse {
  name: string
  address: string
  lat: number
  lon: number
  distanceM: number
  engines: number[]
  ladders: number[]
  battalions: number[]
  rescues: number[]
  squads: number[]
}

interface FirehouseRow {
  facilityname?: string
  facilityaddress?: string
  latitude?: string
  longitude?: string
}

function numbers(name: string, re: RegExp): number[] {
  const out: number[] = []
  for (const m of name.matchAll(re)) out.push(Number(m[1]))
  return out
}

// The firehouse listing is static citywide data; every escalation preview
// re-derives from it, so one SODA fetch per 10 minutes is plenty.
let firehouseCache: { rows: FirehouseRow[]; at: number } | null = null
const FIREHOUSE_CACHE_MS = 10 * 60_000

export async function fetchFirehousesNear(lat: number, lon: number): Promise<Firehouse[]> {
  let rows: FirehouseRow[]
  if (firehouseCache && Date.now() - firehouseCache.at < FIREHOUSE_CACHE_MS) {
    rows = firehouseCache.rows
  } else {
    const params = new URLSearchParams({
      $select: 'facilityname,facilityaddress,latitude,longitude',
      $limit: '400',
    })
    const res = await fetch(`${FIREHOUSES}?${params}`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`firehouses SODA ${res.status}`)
    rows = (await res.json()) as FirehouseRow[]
    firehouseCache = { rows, at: Date.now() }
  }
  return rows
    .filter((r) => r.latitude && r.longitude && r.facilityname)
    .map((r) => {
      const name = r.facilityname!
      return {
        name,
        address: r.facilityaddress ?? '',
        lat: Number(r.latitude),
        lon: Number(r.longitude),
        distanceM: haversineMeters(lat, lon, Number(r.latitude), Number(r.longitude)),
        engines: numbers(name, /Engine (\d+)/gi),
        ladders: numbers(name, /Ladder (\d+)/gi),
        battalions: numbers(name, /Battalion (\d+)/gi),
        rescues: numbers(name, /Rescue (\d+)/gi),
        squads: numbers(name, /Squad (\d+)/gi),
      }
    })
    .sort((a, b) => a.distanceM - b.distanceM)
}
