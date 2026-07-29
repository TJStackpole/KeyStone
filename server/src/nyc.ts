import { haversineMeters } from './lib/geo.js'

// FDNY Firehouse Listing (NYC Open Data, keyless) — the simulator dispatches
// the real nearest companies from their real houses.
const FIREHOUSES = 'https://data.cityofnewyork.us/resource/hc8x-tcnd.json'

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

export async function fetchFirehousesNear(lat: number, lon: number): Promise<Firehouse[]> {
  const params = new URLSearchParams({
    $select: 'facilityname,facilityaddress,latitude,longitude',
    $limit: '400',
  })
  const res = await fetch(`${FIREHOUSES}?${params}`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`firehouses SODA ${res.status}`)
  const rows = (await res.json()) as FirehouseRow[]
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
