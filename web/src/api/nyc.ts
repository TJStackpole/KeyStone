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
const STREET_CENTERLINE = 'https://data.cityofnewyork.us/resource/inkn-q76z.json'
const TAX_LOTS = 'https://data.cityofnewyork.us/resource/i38t-6if2.json'

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
    links.push({
      label: 'C OF O PDFs',
      url: `https://a810-bisweb.nyc.gov/bisweb/COsByLocationServlet?allbin=${encodeURIComponent(bin)}`,
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

export interface StreetLabel {
  name: string
  lat: number
  lon: number
  /** Street direction at the label anchor, degrees true — labels run along it. */
  bearingDeg: number
}

interface CenterlineRow {
  full_street_name?: string
  segmentlength?: string
  the_geom?: { type: string; coordinates: number[][][] }
}

/**
 * Street/avenue names near a point from the NYC Street Centerline (CSCL).
 * One label per distinct street name, anchored at the midpoint of its longest
 * nearby segment — enough to caption the fireground like a map.
 */
export async function fetchStreetLabels(lat: number, lon: number, radiusM = 500): Promise<StreetLabel[]> {
  maybeFailNyc()
  const params = new URLSearchParams({
    $select: 'full_street_name,segmentlength,the_geom',
    $where: `within_circle(the_geom, ${lat}, ${lon}, ${radiusM})`,
    $limit: '400',
  })
  const res = await fetch(`${STREET_CENTERLINE}?${params}`)
  if (!res.ok) throw new Error(`centerline SODA ${res.status}`)
  const rows = (await res.json()) as CenterlineRow[]

  const best = new Map<string, { len: number; lat: number; lon: number; bearingDeg: number }>()
  for (const r of rows) {
    const name = r.full_street_name?.trim()
    const line = r.the_geom?.type === 'MultiLineString' ? r.the_geom.coordinates[0] : undefined
    if (!name || !line?.length) continue
    const len = Number(r.segmentlength ?? 0)
    const prev = best.get(name)
    if (prev && prev.len >= len) continue
    // True geometric midpoint of the middle segment — line[floor(n/2)] on a
    // 2-vertex segment is the END vertex, putting labels at intersections.
    const i2 = Math.ceil((line.length - 1) / 2)
    const i1 = Math.max(0, i2 - 1)
    const [aLon, aLat] = line[i1]
    const [bLon, bLat] = line[i2]
    const mLat = (aLat + bLat) / 2
    const mLon = (aLon + bLon) / 2
    const bearingDeg =
      (Math.atan2((bLon - aLon) * Math.cos((mLat * Math.PI) / 180), bLat - aLat) * 180) / Math.PI
    best.set(name, { len, lat: mLat, lon: mLon, bearingDeg: (bearingDeg + 360) % 360 })
  }
  return [...best.entries()]
    .sort((a, b) => b[1].len - a[1].len)
    .slice(0, 30)
    .map(([name, v]) => ({ name, lat: v.lat, lon: v.lon, bearingDeg: v.bearingDeg }))
}

// --------------------- live traffic (DOT Traffic Speeds NBE) -----------------

export interface TrafficLink {
  name: string
  speedMph: number
  asOf: string
  /** [lon, lat] vertices along the sensor link. */
  positions: [number, number][]
}

interface TrafficRow {
  link_id?: string
  speed?: string
  status?: string
  link_points?: string
  link_name?: string
  data_as_of?: string
}

const TRAFFIC_SPEEDS = 'https://data.cityofnewyork.us/resource/i4gi-tjb9.json'

// Truncated link_points tokens produce coordinates far outside the city —
// keep vertices to the NYC operating box or the polyline crosses the Atlantic.
const NYC = { latMin: 40.3, latMax: 41.2, lonMin: -74.6, lonMax: -73.3 }

/**
 * Live link speeds from NYC DOT (TRANSCOM feed). The dataset is a rolling
 * ARCHIVE — one row per link per ~5-minute reading — so we must order by
 * data_as_of DESC and keep only the newest reading per link, or the layer
 * draws stacks of stale, mutually contradictory polylines.
 */
export async function fetchTrafficLinks(lat: number, lon: number, radiusM = 2500): Promise<TrafficLink[]> {
  maybeFailNyc()
  const params = new URLSearchParams({
    $select: 'link_id,speed,status,link_points,link_name,data_as_of',
    $order: 'data_as_of DESC',
    $limit: '4000',
  })
  const res = await fetch(`${TRAFFIC_SPEEDS}?${params}`)
  if (!res.ok) throw new Error(`traffic SODA ${res.status}`)
  const rows = (await res.json()) as TrafficRow[]
  const seen = new Set<string>()
  const out: TrafficLink[] = []
  // Freshness cutoff: a halted sensor's last reading stays "newest" for its
  // link forever — don't paint half-hour-old speeds as live traffic.
  const cutoffMs = 30 * 60 * 1000
  const now = Date.now()
  for (const r of rows) {
    const linkId = r.link_id ?? r.link_name ?? ''
    if (seen.has(linkId)) continue // rows are newest-first; keep the latest per link
    seen.add(linkId)
    const asOf = Date.parse(r.data_as_of ?? '')
    if (Number.isFinite(asOf) && now - asOf > cutoffMs) continue
    const speed = Number(r.speed)
    if (!Number.isFinite(speed) || speed <= 0 || Number(r.status ?? 0) < 0) continue
    const positions: [number, number][] = []
    for (const pair of (r.link_points ?? '').trim().split(/\s+/)) {
      const [pLat, pLon] = pair.split(',').map(Number)
      if (
        Number.isFinite(pLat) &&
        Number.isFinite(pLon) &&
        pLat >= NYC.latMin &&
        pLat <= NYC.latMax &&
        pLon >= NYC.lonMin &&
        pLon <= NYC.lonMax
      ) {
        positions.push([pLon, pLat])
      }
    }
    if (positions.length < 2) continue
    const near = positions.some(([pLon, pLat]) => haversineMeters(lat, lon, pLat, pLon) <= radiusM)
    if (!near) continue
    out.push({ name: r.link_name ?? 'link', speedMph: speed, asOf: r.data_as_of ?? '', positions })
  }
  return out
}

// --------------------- Certificates of Occupancy (by BIN) -------------------
// The closest public record to "blueprints": floor-by-floor legal use and
// occupancy. Full architectural drawings are NOT published by NYC (security);
// C of O records + the BIS PDF list are what a chief can legally pull up.

export interface CofoRecord {
  date: string
  jobNumber: string
  jobType: string
  issueType: string
  status: string
}

interface CofoRow {
  c_o_issue_date?: string
  job_number?: string
  job_type?: string
  issue_type?: string
  application_status_raw?: string
}

const COFO = 'https://data.cityofnewyork.us/resource/bs8b-p36w.json'

/** Most recent DOB Certificates of Occupancy for a BIN (newest first). */
export async function fetchCertificatesOfOccupancy(bin: string, signal?: AbortSignal): Promise<CofoRecord[]> {
  maybeFailNyc()
  const params = new URLSearchParams({
    $select: 'c_o_issue_date,job_number,job_type,issue_type,application_status_raw',
    $where: `bin='${bin.replace(/'/g, '')}'`,
    $order: 'c_o_issue_date DESC',
    $limit: '6',
  })
  const res = await fetch(`${COFO}?${params}`, { signal })
  if (!res.ok) throw new Error(`C of O SODA ${res.status}`)
  const rows = (await res.json()) as CofoRow[]
  return rows.map((r) => ({
    date: (r.c_o_issue_date ?? '').slice(0, 10) || '—',
    jobNumber: r.job_number ?? '—',
    jobType: r.job_type ?? '',
    issueType: r.issue_type ?? '',
    status: r.application_status_raw ?? '',
  }))
}

// ---------------------------------------------------------------------------
// DOF Digital Tax Map — tax lot polygons. The lot-border overlay: every lot
// near the camera gets its boundary drawn, and a click inside a border
// resolves that lot's own address (via PLUTO by BBL).
// ---------------------------------------------------------------------------

export interface TaxLot {
  bbl: string
  /** GeoJSON MultiPolygon coordinates: polygons -> rings -> [lon, lat]. */
  polygons: number[][][][]
}

interface TaxLotRow {
  bbl?: string
  the_geom?: { type: string; coordinates: number[][][][] }
}

/** Tax lots within `radiusM` of a point (SODA within_circle). */
export async function fetchTaxLots(lat: number, lon: number, radiusM: number, signal?: AbortSignal): Promise<TaxLot[]> {
  maybeFailNyc()
  const params = new URLSearchParams({
    $select: 'bbl,the_geom',
    $where: `within_circle(the_geom, ${lat}, ${lon}, ${Math.round(radiusM)})`,
    $limit: '1500',
  })
  const res = await fetch(`${TAX_LOTS}?${params}`, { signal })
  if (!res.ok) throw new Error(`tax lots SODA ${res.status}`)
  const rows = (await res.json()) as TaxLotRow[]
  return rows
    .filter((r) => r.bbl && r.the_geom?.type === 'MultiPolygon' && r.the_geom.coordinates?.length)
    .map((r) => ({ bbl: r.bbl!, polygons: r.the_geom!.coordinates }))
}

// ---------------------------------------------------------------------------
// NYC Facilities Database (FacDB) — citywide facility points for the OVERLAYS
// menu: every firehouse, official FDNY buildings, NYPD precinct houses,
// hospitals, NYCEM offices.
// ---------------------------------------------------------------------------

const FACDB = 'https://data.cityofnewyork.us/resource/ji82-xba5.json'

export interface Facility {
  name: string
  lat: number
  lon: number
}

interface FacilityRow {
  facname?: string
  latitude?: string
  longitude?: string
}

/** Citywide facility points matching a SoQL predicate. */
export async function fetchFacilities(where: string, signal?: AbortSignal): Promise<Facility[]> {
  maybeFailNyc()
  const params = new URLSearchParams({
    $select: 'facname,latitude,longitude',
    $where: `(${where}) AND latitude IS NOT NULL`,
    $limit: '500',
  })
  const res = await fetch(`${FACDB}?${params}`, { signal })
  if (!res.ok) throw new Error(`FacDB SODA ${res.status}`)
  const rows = (await res.json()) as FacilityRow[]
  return rows
    .filter((r) => r.facname && r.latitude && r.longitude)
    .map((r) => ({ name: r.facname!, lat: Number(r.latitude), lon: Number(r.longitude) }))
    .filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon))
}
