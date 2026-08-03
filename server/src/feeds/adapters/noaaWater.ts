import type { FeedAdapter, FeedContext } from '../types.js'

// Fixed federal NOS stations — positions never move, safe to hardcode.
const STATIONS = [
  { id: '8518750', name: 'The Battery', lat: 40.7006, lon: -74.0142 },
  { id: '8516945', name: 'Kings Point', lat: 40.8103, lon: -73.7649 },
  { id: '8531680', name: 'Sandy Hook', lat: 40.4669, lon: -74.0094 },
] as const

const BASE = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'
const TREND_WINDOW_MS = 30 * 60_000
const TREND_THRESHOLD_FT = 0.05

interface WaterSample {
  t: number
  v: number
}

interface WaterStation {
  id: string
  name: string
  lat: number
  lon: number
  waterLevelFt: number
  trend: 'rising' | 'falling' | 'steady'
  ratePerHrFt: number
  obsAt: number
  series: WaterSample[]
}

export interface NoaaWaterPayload {
  stations: WaterStation[]
}

// CO-OPS returns HTTP 200 with an error object for bad/silent stations.
interface CoopsResponse {
  error?: { message?: string }
  data?: { t?: string; v?: string }[]
}

// Timestamps arrive as 'YYYY-MM-DD HH:MM' with no zone marker (time_zone=gmt).
function parseGmt(t: string): number {
  return Date.parse(t.replace(' ', 'T') + ':00Z')
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

async function pollStation(
  ctx: FeedContext,
  station: (typeof STATIONS)[number],
): Promise<WaterStation> {
  const url =
    `${BASE}?product=water_level&station=${station.id}&range=3` +
    `&datum=MLLW&units=english&time_zone=gmt&format=json&application=keystone-nycem`
  const body = (await ctx.fetchJson(url, { timeoutMs: 15_000 })) as CoopsResponse

  if (body.error) {
    throw new Error(`${station.name}: ${body.error.message ?? 'upstream error'}`)
  }

  // v can be '' for missed 6-min samples; parseFloat('') is NaN and drops out.
  const series: WaterSample[] = (body.data ?? [])
    .map((d) => ({ t: parseGmt(d.t ?? ''), v: Number.parseFloat(d.v ?? '') }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v))
    .sort((a, b) => a.t - b.t)

  const last = series[series.length - 1]
  if (!last) throw new Error(`${station.name}: no water_level samples`)

  const windowed = series.filter((p) => p.t >= last.t - TREND_WINDOW_MS)
  const first = windowed[0] ?? last
  const deltaFt = last.v - first.v
  const hours = (last.t - first.t) / 3_600_000
  const trend = deltaFt > TREND_THRESHOLD_FT ? 'rising' : deltaFt < -TREND_THRESHOLD_FT ? 'falling' : 'steady'

  return {
    id: station.id,
    name: station.name,
    lat: station.lat,
    lon: station.lon,
    waterLevelFt: round2(last.v),
    trend,
    ratePerHrFt: hours > 0 ? round2(deltaFt / hours) : 0,
    obsAt: last.t,
    series,
  }
}

const noaaWater: FeedAdapter<NoaaWaterPayload> = {
  capabilityId: 'feeds.noaa-water',
  id: 'noaa-water',
  name: 'NOAA Harbor Water Levels',
  profiles: ['nycem', 'fdny'],
  attribution: 'NOAA CO-OPS',
  refreshIntervalMs: 6 * 60_000,

  async poll(ctx: FeedContext): Promise<NoaaWaterPayload> {
    const results = await Promise.allSettled(STATIONS.map((s) => pollStation(ctx, s)))
    const stations = results
      .filter((r): r is PromiseFulfilledResult<WaterStation> => r.status === 'fulfilled')
      .map((r) => r.value)

    if (stations.length === 0) {
      const reasons = results
        .map((r) => (r.status === 'rejected' ? String(r.reason) : null))
        .filter((m): m is string => m !== null)
      throw new Error(`all NOAA stations failed: ${reasons.join('; ')}`)
    }
    return { stations }
  },
}

export default noaaWater
