import { sodaInit } from '../lib/soda'
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
  const res = await fetch(`${PLUTO}?${params}`, { ...sodaInit(), signal })
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
  const res = await fetch(`${HYDRANTS}?${params}`, { ...sodaInit(), signal })
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
  const res = await fetch(`${base}?${params}`, { ...sodaInit(), signal })
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
        { ...sodaInit(), signal },
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
  const res = await fetch(`${FIREHOUSES}?${params}`, { ...sodaInit(), signal })
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
export async function fetchStreetLabels(
  lat: number,
  lon: number,
  radiusM = 500,
  signal?: AbortSignal,
): Promise<StreetLabel[]> {
  maybeFailNyc()
  const params = new URLSearchParams({
    $select: 'full_street_name,segmentlength,the_geom',
    $where: `within_circle(the_geom, ${lat}, ${lon}, ${radiusM})`,
    $limit: '600',
  })
  const res = await fetch(`${STREET_CENTERLINE}?${params}`, { ...sodaInit(), signal })
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
    .slice(0, 45) // every street in a camera-radius view gets its name
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
/**
 * All FRESH citywide traffic links, one fetch. Radius filtering happens in
 * the caller (linksNear) so the 2500 m try + 8000 m widen reuse ONE download
 * instead of doubling a multi-hundred-KB request. The 30-min-fresh window is
 * ~750 rows, so $limit 1500 covers it with margin at a third of the payload.
 */
export interface TrafficFetch {
  links: TrafficLink[]
  /** Minutes the FEED HEAD trails the wall clock — the Socrata mirror has
   *  been observed lagging a full hour; the map labels anything over 30. */
  ageMin: number | null
}

// data_as_of is a FLOATING Eastern-local timestamp — no zone suffix. Naive
// Date.parse reads it in the CLIENT's zone: right on an Eastern machine by
// luck, four-plus hours wrong on a UTC-configured field tablet (every reading
// then looks future-dated → "fresh" forever, stale speeds painted as live).
// Convert explicitly through America/New_York, DST-aware.
const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})
function etParts(atMs: number): Record<string, string> {
  return Object.fromEntries(ET_FMT.formatToParts(atMs).map((p) => [p.type, p.value]))
}
function etOffsetMs(atMs: number): number {
  const p = etParts(atMs)
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
  return wall - atMs
}
function parseEasternMs(ts: string): number {
  const wall = Date.parse(ts.replace(/(\.\d+)?(Z|[+-]\d\d:?\d\d)?$/, '') + 'Z')
  if (!Number.isFinite(wall)) return NaN
  // Two passes so a reading near a DST boundary lands on the right side.
  let ms = wall - etOffsetMs(wall)
  ms = wall - etOffsetMs(ms)
  return ms
}
/** Now minus deltaMs, rendered as a floating ET string for $where clauses. */
function etFloating(atMs: number): string {
  const p = etParts(atMs)
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`
}

const TRAFFIC_SELECT = 'link_id,speed,status,link_points,link_name,data_as_of'

async function trafficRows(where: string | null, signal?: AbortSignal): Promise<TrafficRow[]> {
  const params = new URLSearchParams({
    $select: TRAFFIC_SELECT,
    $order: 'data_as_of DESC',
    $limit: '1500',
  })
  if (where) params.set('$where', where)
  const res = await fetch(`${TRAFFIC_SPEEDS}?${params}`, { ...sodaInit(), signal })
  if (!res.ok) throw new Error(`traffic SODA ${res.status}`)
  return (await res.json()) as TrafficRow[]
}

export async function fetchTrafficLinks(signal?: AbortSignal): Promise<TrafficFetch> {
  maybeFailNyc()
  // FRESH-FIRST: ask for the last 45 minutes by name. When the mirror is
  // healthy this is the whole answer (and a smaller download); when it
  // resumes after a stall, this query sees the recovery on the next cycle —
  // the bare head query kept riding a stale cached ordering. Only when the
  // window is EMPTY (mirror stalled) fall back to the newest the mirror has,
  // labeled with its age.
  let rows = await trafficRows(`data_as_of > '${etFloating(Date.now() - 45 * 60_000)}'`, signal)
  if (rows.length === 0) rows = await trafficRows(null, signal)
  const seen = new Set<string>()
  const out: TrafficLink[] = []
  const now = Date.now()
  // Freshness is judged RELATIVE TO THE FEED HEAD, not the wall clock: the
  // mirror itself lags (observed 60-115 min behind), and a wall-clock cutoff
  // silently blanked the whole layer. Halted sensors still drop (their
  // last reading trails the head), and a head older than 2 h is unusable.
  const newestMs = parseEasternMs(rows[0]?.data_as_of ?? '')
  const ageMin = Number.isFinite(newestMs) ? Math.max(0, Math.round((now - newestMs) / 60_000)) : null
  // CURRENT OR ABSENT: past 30 minutes the layer draws NOTHING rather than
  // stale speeds or a warning banner — what's on the map is always real.
  // The fresh-first query + 60 s cycle repopulate within a minute of the
  // mirror catching back up.
  if (ageMin !== null && ageMin > 30) {
    console.warn(`[traffic] DOT mirror ${ageMin} min behind — layer withheld until it catches up`)
    return { links: [], ageMin }
  }
  const cutoffMs = 15 * 60 * 1000
  for (const r of rows) {
    const linkId = r.link_id ?? r.link_name ?? ''
    if (seen.has(linkId)) continue // rows are newest-first; keep the latest per link
    seen.add(linkId)
    const asOf = parseEasternMs(r.data_as_of ?? '')
    if (Number.isFinite(asOf) && Number.isFinite(newestMs) && newestMs - asOf > cutoffMs) continue
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
    out.push({ name: r.link_name ?? 'link', speedMph: speed, asOf: r.data_as_of ?? '', positions })
  }
  return { links: out, ageMin }
}

/** Links with any vertex within radiusM of the point — filters ONE download. */
export function linksNear(links: TrafficLink[], lat: number, lon: number, radiusM: number): TrafficLink[] {
  return links.filter((l) => l.positions.some(([pLon, pLat]) => haversineMeters(lat, lon, pLat, pLon) <= radiusM))
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
  const res = await fetch(`${COFO}?${params}`, { ...sodaInit(), signal })
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
  // Dense residential areas hold 3000+ lots per 900 m (live-counted in the
  // East Village) — an unordered low limit silently drops a DETERMINISTIC
  // half of the grid, and clicks in dropped lots fall back to the
  // wrong-neighbor geocode this feature exists to fix. Order + high cap.
  const params = new URLSearchParams({
    $select: 'bbl,the_geom',
    $where: `within_circle(the_geom, ${lat}, ${lon}, ${Math.round(radiusM)})`,
    $order: 'bbl',
    $limit: '4000',
  })
  const res = await fetch(`${TAX_LOTS}?${params}`, { ...sodaInit(), signal })
  if (!res.ok) throw new Error(`tax lots SODA ${res.status}`)
  const rows = (await res.json()) as TaxLotRow[]
  if (rows.length === 4000) console.warn('[lots] grid truncated at 4000 lots — zoom in for full coverage')
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
  const res = await fetch(`${FACDB}?${params}`, { ...sodaInit(), signal })
  if (!res.ok) throw new Error(`FacDB SODA ${res.status}`)
  const rows = (await res.json()) as FacilityRow[]
  return rows
    .filter((r) => r.facname && r.latitude && r.longitude)
    .map((r) => ({ name: r.facname!, lat: Number(r.latitude), lon: Number(r.longitude) }))
    .filter((f) => Number.isFinite(f.lat) && Number.isFinite(f.lon))
}

// ---------------------------------------------------------------------------
// Road network + tunnels (NYC Street Centerline) — the OVERLAYS road layer.
// rw_type: 1 street, 2 highway, 3 bridge, 4 tunnel, 9 ramp.
// ---------------------------------------------------------------------------

export interface RoadSegment {
  name: string
  /** True for highways/bridges/ramps — drawn heavier than local streets. */
  major: boolean
  /** MultiLineString parts: [ [ [lon,lat], ... ], ... ] */
  lines: number[][][]
}

interface CenterlineGeomRow {
  full_street_name?: string
  rw_type?: string
  the_geom?: { type: string; coordinates: number[][][] }
}

/** Drivable road segments (streets/highways/bridges/ramps) near a point. */
export async function fetchRoadSegments(
  lat: number,
  lon: number,
  radiusM: number,
  signal?: AbortSignal,
): Promise<RoadSegment[]> {
  maybeFailNyc()
  const params = new URLSearchParams({
    $select: 'full_street_name,rw_type,the_geom',
    $where: `rw_type in('1','2','3','9') AND within_circle(the_geom, ${lat}, ${lon}, ${Math.round(radiusM)})`,
    $order: 'objectid',
    $limit: '3000',
  })
  const res = await fetch(`${STREET_CENTERLINE}?${params}`, { ...sodaInit(), signal })
  if (!res.ok) throw new Error(`centerline SODA ${res.status}`)
  const rows = (await res.json()) as CenterlineGeomRow[]
  return rows
    .filter((r) => r.the_geom?.type === 'MultiLineString' && r.the_geom.coordinates?.length)
    .map((r) => ({
      name: (r.full_street_name ?? '').trim(),
      major: r.rw_type === '2' || r.rw_type === '3' || r.rw_type === '9',
      lines: r.the_geom!.coordinates,
    }))
}

/** Every vehicular tunnel segment citywide (they're sparse — 171 rows). */
export async function fetchTunnels(signal?: AbortSignal): Promise<RoadSegment[]> {
  maybeFailNyc()
  const params = new URLSearchParams({
    $select: 'full_street_name,rw_type,the_geom',
    $where: `rw_type='4'`,
    $limit: '400',
  })
  const res = await fetch(`${STREET_CENTERLINE}?${params}`, { ...sodaInit(), signal })
  if (!res.ok) throw new Error(`centerline SODA ${res.status}`)
  const rows = (await res.json()) as CenterlineGeomRow[]
  return rows
    .filter((r) => r.the_geom?.type === 'MultiLineString' && r.the_geom.coordinates?.length)
    .map((r) => ({
      name: (r.full_street_name ?? '').trim(),
      major: true,
      lines: r.the_geom!.coordinates,
    }))
}
