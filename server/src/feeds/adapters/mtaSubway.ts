import GtfsRealtimeBindings from 'gtfs-realtime-bindings'
import type { FeedAdapter, FeedContext } from '../types.js'

// MTA GTFS-rt has been keyless since 2023 — no x-api-key header anywhere.
const ALERTS_URL =
  'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts'

// The 8 NYCT position feeds; '' = numbered lines (1-7 + S).
const POSITION_URLS = ['', '-ace', '-bdfm', '-g', '-jz', '-nqrw', '-l', '-si'].map(
  (s) => `https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs${s}`,
)

// Subway VehiclePositions carry stop_id but no lat/lon — coordinates come from
// the (static) MTA Subway Stations dataset. ~500 rows, so $limit=1000 covers it.
const STATIONS_URL =
  'https://data.ny.gov/resource/39hk-dx4f.json?$select=gtfs_stop_id,stop_name,gtfs_latitude,gtfs_longitude&$limit=1000'

const MAX_ALERTS = 40
const MAX_TRAINS = 500

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime
const { VehicleStopStatus } = GtfsRealtimeBindings.transit_realtime.VehiclePosition

export interface SubwayAlert {
  id: string
  routes: string[]
  header: string
  activeUntil: number | null
}

export interface SubwayTrain {
  id: string
  route: string
  stopId: string
  stopName: string
  lat: number
  lon: number
  status: 'AT' | 'INCOMING' | 'ENROUTE'
  at: number
}

export interface MtaSubwayPayload {
  alerts: SubwayAlert[]
  trains: SubwayTrain[]
}

/** GTFS-rt epoch fields decode as protobufjs Long, not number. */
type EpochSec = number | { toNumber(): number } | null | undefined

function toMs(v: EpochSec): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : v.toNumber()
  return n > 0 ? n * 1000 : null
}

/** Alert text arrives with 'en' and 'en-html' translations — take plain 'en'. */
function english(
  t: { translation?: readonly { text?: string | null; language?: string | null }[] | null } | null | undefined,
): string {
  const list = t?.translation ?? []
  const en = list.find((x) => x.language === 'en') ?? list.find((x) => !x.language) ?? list[0]
  return en?.text ?? ''
}

function latestEnd(
  periods: readonly { end?: EpochSec }[] | null | undefined,
): number | null {
  let max: number | null = null
  for (const p of periods ?? []) {
    const end = toMs(p.end)
    if (end !== null && (max === null || end > max)) max = end
  }
  return max
}

function trainStatus(s: number | null | undefined): SubwayTrain['status'] {
  if (s === VehicleStopStatus.STOPPED_AT) return 'AT'
  if (s === VehicleStopStatus.INCOMING_AT) return 'INCOMING'
  return 'ENROUTE' // GTFS-rt default when current_status is omitted
}

// Static for years at a time — fetched once per process. Socrata serves
// coordinates as strings.
const stations = new Map<string, { name: string; lat: number; lon: number }>()

async function loadStations(ctx: FeedContext): Promise<void> {
  if (stations.size > 0) return
  const rows = await ctx.fetchJson(STATIONS_URL)
  if (!Array.isArray(rows)) throw new Error('mta-subway: stations payload not an array')
  for (const row of rows) {
    const r = row as Record<string, unknown>
    const id = typeof r.gtfs_stop_id === 'string' ? r.gtfs_stop_id : ''
    const lat = Number(r.gtfs_latitude)
    const lon = Number(r.gtfs_longitude)
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue
    stations.set(id, {
      name: typeof r.stop_name === 'string' ? r.stop_name : id,
      lat,
      lon,
    })
  }
}

async function fetchAlerts(ctx: FeedContext): Promise<SubwayAlert[]> {
  const buf = await ctx.fetchBuffer(ALERTS_URL)
  const msg = FeedMessage.decode(new Uint8Array(buf))
  const out: SubwayAlert[] = []
  for (const ent of msg.entity ?? []) {
    if (out.length >= MAX_ALERTS) break
    const a = ent.alert
    if (!a) continue
    const routes = [
      ...new Set(
        (a.informedEntity ?? [])
          .map((e) => e.routeId)
          .filter((r): r is string => typeof r === 'string' && r !== ''),
      ),
    ]
    out.push({
      id: ent.id,
      routes,
      header: english(a.headerText),
      activeUntil: latestEnd(a.activePeriod),
    })
  }
  return out
}

async function fetchTrains(ctx: FeedContext, url: string): Promise<SubwayTrain[]> {
  const buf = await ctx.fetchBuffer(url)
  const msg = FeedMessage.decode(new Uint8Array(buf))
  const headerAt = toMs(msg.header?.timestamp)
  const out: SubwayTrain[] = []
  for (const ent of msg.entity ?? []) {
    const v = ent.vehicle
    if (!v?.stopId) continue
    // stop_ids carry a direction suffix ('635N') — parent station has none.
    const station = stations.get(v.stopId.replace(/[NS]$/, ''))
    if (!station) continue
    out.push({
      id: v.trip?.tripId || ent.id,
      route: v.trip?.routeId ?? '',
      stopId: v.stopId,
      stopName: station.name,
      lat: station.lat,
      lon: station.lon,
      status: trainStatus(v.currentStatus),
      at: toMs(v.timestamp) ?? headerAt ?? Date.now(),
    })
  }
  return out
}

async function poll(ctx: FeedContext): Promise<MtaSubwayPayload> {
  // A failed stations load only means zero resolved trains this round; the
  // cache stays empty so the next poll retries.
  await loadStations(ctx).catch(() => undefined)

  const alertsPromise = fetchAlerts(ctx)
  const trainPromises = POSITION_URLS.map((u) => fetchTrains(ctx, u))
  const [alertsRes] = await Promise.allSettled([alertsPromise])
  const trainRes = await Promise.allSettled(trainPromises)

  const anyPositionsOk = trainRes.some((r) => r.status === 'fulfilled')
  if (alertsRes.status === 'rejected' && !anyPositionsOk) {
    throw new Error(
      `mta-subway: alerts and all ${POSITION_URLS.length} position feeds failed: ${String(
        alertsRes.reason instanceof Error ? alertsRes.reason.message : alertsRes.reason,
      )}`,
    )
  }

  const trains: SubwayTrain[] = []
  for (const r of trainRes) {
    if (r.status !== 'fulfilled') continue
    for (const t of r.value) {
      if (trains.length >= MAX_TRAINS) break
      trains.push(t)
    }
  }

  return {
    alerts: alertsRes.status === 'fulfilled' ? alertsRes.value : [],
    trains,
  }
}

const mtaSubway: FeedAdapter<MtaSubwayPayload> = {
  capabilityId: 'feeds.mta-subway',
  id: 'mta-subway',
  name: 'MTA Subway (GTFS-rt)',
  profiles: 'both',
  attribution: 'MTA GTFS-Realtime',
  refreshIntervalMs: 60_000,
  poll,
}

export default mtaSubway
