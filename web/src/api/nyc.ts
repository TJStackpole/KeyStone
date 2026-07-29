import { maybeFailNyc } from '../lib/failNyc'
import { haversineMeters } from '../lib/geo'

// NYC Open Data (Socrata SODA) endpoints — all keyless.
// Field names verified against the live datasets 2026-07-29.
const PLUTO = 'https://data.cityofnewyork.us/resource/64uk-42ks.json'
const HYDRANTS = 'https://data.cityofnewyork.us/resource/5bgh-vtsn.json'
const FIREHOUSES = 'https://data.cityofnewyork.us/resource/hc8x-tcnd.json'
const DOB_VIOLATIONS = 'https://data.cityofnewyork.us/resource/3h2n-5cm9.json'
const ECB_VIOLATIONS = 'https://data.cityofnewyork.us/resource/6bgk-3dad.json'
const DOB_COMPLAINTS = 'https://data.cityofnewyork.us/resource/eabe-havv.json'
const HPD_VIOLATIONS = 'https://data.cityofnewyork.us/resource/wvxf-dwi5.json'

export interface PlutoAttributes {
  bbl: string
  address?: string
  numFloors?: number
  yearBuilt?: number
  landUseCode?: string
  landUse?: string
  bldgClass?: string
  lotAreaSqFt?: number
}

/** DCP PLUTO land-use codes -> plain-language labels an IC actually wants. */
const LAND_USE: Record<string, string> = {
  '01': 'One & two family',
  '02': 'Multi-family walk-up',
  '03': 'Multi-family elevator',
  '04': 'Mixed residential/commercial',
  '05': 'Commercial & office',
  '06': 'Industrial & manufacturing',
  '07': 'Transportation & utility',
  '08': 'Public facility & institution',
  '09': 'Open space & recreation',
  '10': 'Parking',
  '11': 'Vacant land',
}

function landUseLabel(code?: string): string | undefined {
  if (!code) return undefined
  return LAND_USE[code.padStart(2, '0')]
}

interface PlutoRow {
  bbl?: string
  address?: string
  numfloors?: string
  yearbuilt?: string
  landuse?: string
  bldgclass?: string
  lotarea?: string
}

/** PLUTO parcel attributes by BBL (10-digit borough-block-lot). */
export async function fetchPluto(bbl: string, signal?: AbortSignal): Promise<PlutoAttributes | null> {
  maybeFailNyc()
  // PLUTO stores bbl as a decimal ("1000940025.00000000") — match on the integer part.
  const params = new URLSearchParams({
    $select: 'bbl,address,numfloors,yearbuilt,landuse,bldgclass,lotarea',
    $where: `bbl = ${Number(bbl)}`,
    $limit: '1',
  })
  const res = await fetch(`${PLUTO}?${params}`, { signal })
  if (!res.ok) throw new Error(`PLUTO SODA ${res.status}`)
  const rows = (await res.json()) as PlutoRow[]
  if (!rows.length) return null
  const r = rows[0]
  return {
    bbl,
    address: r.address,
    numFloors: r.numfloors ? Math.round(Number(r.numfloors)) : undefined,
    yearBuilt: r.yearbuilt ? Number(r.yearbuilt) : undefined,
    landUseCode: r.landuse,
    landUse: landUseLabel(r.landuse),
    bldgClass: r.bldgclass,
    lotAreaSqFt: r.lotarea ? Number(r.lotarea) : undefined,
  }
}

export interface Hydrant {
  id: string
  lat: number
  lon: number
  distanceM: number
}

interface HydrantRow {
  unitid?: string
  the_geom?: { type: string; coordinates: [number, number] }
}

/** Hydrants within `radiusM`, sorted nearest-first. */
export async function fetchHydrants(
  lat: number,
  lon: number,
  radiusM = 300,
  signal?: AbortSignal,
): Promise<Hydrant[]> {
  maybeFailNyc()
  const params = new URLSearchParams({
    $select: 'unitid,the_geom',
    $where: `within_circle(the_geom, ${lat}, ${lon}, ${radiusM})`,
    $limit: '200',
  })
  const res = await fetch(`${HYDRANTS}?${params}`, { signal })
  if (!res.ok) throw new Error(`hydrants SODA ${res.status}`)
  const rows = (await res.json()) as HydrantRow[]
  return rows
    .filter((r) => r.the_geom?.type === 'Point')
    .map((r) => {
      const [hLon, hLat] = r.the_geom!.coordinates
      return { id: r.unitid ?? 'hydrant', lat: hLat, lon: hLon, distanceM: haversineMeters(lat, lon, hLat, hLon) }
    })
    .sort((a, b) => a.distanceM - b.distanceM)
}

export interface Firehouse {
  name: string
  address: string
  lat: number
  lon: number
  distanceM: number
}

// ------------------- DOB / housing safety intel (by BIN) --------------------

export interface RecentViolation {
  date: string
  type: string
  description: string
}

export interface BuildingSafety {
  dobTotal: number
  dobActive: number
  ecbTotal: number
  ecbActive: number
  complaintsTotal: number
  complaintsActive: number
  hpdTotal: number
  hpdOpen: number
  recent: RecentViolation[]
}

async function sodaCount(base: string, where: string, signal?: AbortSignal): Promise<number> {
  const params = new URLSearchParams({ $select: 'count(*) as c', $where: where })
  const res = await fetch(`${base}?${params}`, { signal })
  if (!res.ok) throw new Error(`SODA count ${res.status}`)
  const rows = (await res.json()) as { c?: string }[]
  return Number(rows[0]?.c ?? 0)
}

/** DOB "yyyymmdd" -> "yyyy-mm-dd" (already-dashed dates pass through). */
function dobDate(raw?: string): string {
  if (!raw) return '—'
  if (raw.includes('-') || raw.includes('/')) return raw.slice(0, 10)
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw
}

/**
 * Violation/complaint picture for the incident building, straight from NYC
 * Open Data (DOB, ECB/OATH, DOB complaints, HPD housing violations).
 */
export async function fetchBuildingSafety(bin: string, signal?: AbortSignal): Promise<BuildingSafety> {
  maybeFailNyc()
  const b = `bin='${bin.replace(/'/g, '')}'`
  const [dobTotal, dobActive, ecbTotal, ecbActive, complaintsTotal, complaintsActive, hpdTotal, hpdOpen, recentRes] =
    await Promise.all([
      sodaCount(DOB_VIOLATIONS, b, signal),
      sodaCount(DOB_VIOLATIONS, `${b} AND violation_category like '%ACTIVE%'`, signal),
      sodaCount(ECB_VIOLATIONS, b, signal),
      sodaCount(ECB_VIOLATIONS, `${b} AND ecb_violation_status='ACTIVE'`, signal),
      sodaCount(DOB_COMPLAINTS, b, signal),
      sodaCount(DOB_COMPLAINTS, `${b} AND status='ACTIVE'`, signal),
      sodaCount(HPD_VIOLATIONS, b, signal),
      sodaCount(HPD_VIOLATIONS, `${b} AND currentstatus like '%OPEN%'`, signal),
      fetch(
        `${DOB_VIOLATIONS}?${new URLSearchParams({
          $select: 'issue_date,violation_type,description',
          $where: b,
          $order: 'issue_date DESC',
          $limit: '4',
        })}`,
        { signal },
      ),
    ])
  const recentRows = recentRes.ok
    ? ((await recentRes.json()) as { issue_date?: string; violation_type?: string; description?: string }[])
    : []
  return {
    dobTotal,
    dobActive,
    ecbTotal,
    ecbActive,
    complaintsTotal,
    complaintsActive,
    hpdTotal,
    hpdOpen,
    recent: recentRows.map((r) => ({
      date: dobDate(r.issue_date),
      type: (r.violation_type ?? '').split(/\s{2,}/)[0].trim(),
      description: r.description ?? '',
    })),
  }
}

/** External deep links for the incident building (open in a new tab). */
export function buildingLinks(bin?: string, bbl?: string): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = []
  if (bin) {
    links.push({
      label: 'DOB BIS PROFILE',
      url: `https://a810-bisweb.nyc.gov/bisweb/PropertyProfileOverviewServlet?bin=${encodeURIComponent(bin)}`,
    })
  }
  if (bbl && bbl.length >= 10) {
    const boro = bbl.slice(0, 1)
    const block = String(Number(bbl.slice(1, 6)))
    const lot = String(Number(bbl.slice(6, 10)))
    links.push({ label: 'ZOLA LOT', url: `https://zola.planning.nyc.gov/l/lot/${boro}/${block}/${lot}` })
  }
  return links
}

interface FirehouseRow {
  facilityname?: string
  facilityaddress?: string
  latitude?: string
  longitude?: string
}

/**
 * All FDNY firehouses (219 rows citywide — small enough to pull once and sort
 * client-side; also reused by the Phase 4 simulator for realistic origins).
 */
export async function fetchFirehouses(lat: number, lon: number, signal?: AbortSignal): Promise<Firehouse[]> {
  maybeFailNyc()
  const params = new URLSearchParams({
    $select: 'facilityname,facilityaddress,latitude,longitude',
    $limit: '400',
  })
  const res = await fetch(`${FIREHOUSES}?${params}`, { signal })
  if (!res.ok) throw new Error(`firehouses SODA ${res.status}`)
  const rows = (await res.json()) as FirehouseRow[]
  return rows
    .filter((r) => r.latitude && r.longitude)
    .map((r) => {
      const fLat = Number(r.latitude)
      const fLon = Number(r.longitude)
      return {
        name: r.facilityname ?? 'FDNY facility',
        address: r.facilityaddress ?? '',
        lat: fLat,
        lon: fLon,
        distanceM: haversineMeters(lat, lon, fLat, fLon),
      }
    })
    .sort((a, b) => a.distanceM - b.distanceM)
}
