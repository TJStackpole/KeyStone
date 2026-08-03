import type { FeedAdapter, FeedContext } from '../types.js'

interface Gage {
  id: string
  name: string
  lat: number
  lon: number
  gageHeightFt: number
  /** ms since epoch of the reading. */
  obsAt: number
}

interface GagesPayload {
  gages: Gage[]
}

/** Minimal slice of the WaterML 1.1 JSON envelope we actually read. */
interface IvResponse {
  value?: {
    timeSeries?: {
      sourceInfo?: {
        siteName?: string
        siteCode?: { value?: string }[]
        geoLocation?: { geogLocation?: { latitude?: number; longitude?: number } }
      }
      variable?: { noDataValue?: number }
      values?: { value?: { value?: string; dateTime?: string }[] }[]
    }[]
  }
}

// Legacy NWIS IV service. USGS has announced a migration to OGC APIs
// (api.waterdata.usgs.gov) — when the legacy endpoint sunsets, this function
// is the only thing that should change.
function ivUrl(): string {
  const q = new URLSearchParams({
    format: 'json',
    bBox: '-74.30,40.45,-73.65,40.95', // NYC metro
    parameterCd: '00065', // gage height, ft
    siteStatus: 'active',
  })
  return `https://waterservices.usgs.gov/nwis/iv/?${q}`
}

async function poll(ctx: FeedContext): Promise<GagesPayload> {
  const raw = (await ctx.fetchJson(ivUrl())) as IvResponse
  const series = raw.value?.timeSeries
  if (!Array.isArray(series)) throw new Error('usgs-gages: unexpected IV response shape')

  // A site can carry several timeSeries (one per measurement method) — keep
  // the freshest valid reading per site.
  const bySite = new Map<string, Gage>()
  for (const ts of series) {
    const info = ts.sourceInfo
    const id = info?.siteCode?.[0]?.value
    const lat = info?.geoLocation?.geogLocation?.latitude
    const lon = info?.geoLocation?.geogLocation?.longitude
    if (!id || typeof lat !== 'number' || typeof lon !== 'number') continue
    const noData = ts.variable?.noDataValue

    for (const block of ts.values ?? []) {
      const readings = block.value ?? []
      const last = readings[readings.length - 1]
      if (!last?.dateTime) continue
      const ft = Number(last.value)
      if (!Number.isFinite(ft) || ft === noData) continue // -999999 sentinel
      const obsAt = Date.parse(last.dateTime)
      if (!Number.isFinite(obsAt)) continue
      const prev = bySite.get(id)
      if (!prev || obsAt > prev.obsAt) {
        bySite.set(id, { id, name: info?.siteName ?? id, lat, lon, gageHeightFt: ft, obsAt })
      }
    }
  }
  return { gages: [...bySite.values()] }
}

const usgsGages: FeedAdapter<GagesPayload> = {
  capabilityId: 'feeds.usgs-gages',
  id: 'usgs-gages',
  name: 'USGS Stream Gages',
  profiles: ['nycem', 'fdny'],
  attribution: 'USGS',
  refreshIntervalMs: 10 * 60_000,
  poll,
}

export default usgsGages
