import type { FeedAdapter, FeedContext } from '../types.js'

const BASE = 'https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries'
const LOOKBACK_MS = 365 * 24 * 3_600_000

interface Declaration {
  disasterNumber: number
  county: string
  incidentType: string
  title: string
  declaredAt: number
  active: boolean
}

export interface OpenFemaPayload {
  declarations: Declaration[]
}

// One row per disasterNumber × designatedArea (county); v2 field names.
interface FemaRow {
  disasterNumber?: number
  designatedArea?: string
  incidentType?: string
  declarationTitle?: string
  declarationDate?: string
  incidentEndDate?: string | null
}

interface FemaResponse {
  DisasterDeclarationsSummaries?: FemaRow[]
}

const openFema: FeedAdapter<OpenFemaPayload> = {
  capabilityId: 'feeds.openfema',
  id: 'openfema',
  name: 'FEMA Disaster Declarations',
  profiles: ['nycem'],
  attribution: 'OpenFEMA',
  refreshIntervalMs: 60 * 60_000,

  async poll(ctx: FeedContext): Promise<OpenFemaPayload> {
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString()
    const filter = `state eq 'NY' and declarationDate ge '${since}'`
    const url =
      `${BASE}?$filter=${encodeURIComponent(filter)}` +
      `&$orderby=${encodeURIComponent('declarationDate desc')}&$top=50`
    const body = (await ctx.fetchJson(url, { timeoutMs: 20_000 })) as FemaResponse

    // Under load FEMA's edge serves an HTML error page in place of JSON; a
    // parsed body without the entity array is the same failure.
    const rows = body.DisasterDeclarationsSummaries
    if (!Array.isArray(rows)) {
      throw new Error('OpenFEMA: response missing DisasterDeclarationsSummaries')
    }

    const now = Date.now()
    const parsed = rows
      .map((r) => ({ row: r, declaredAt: Date.parse(r.declarationDate ?? '') }))
      .filter((p) => typeof p.row.disasterNumber === 'number' && Number.isFinite(p.declaredAt))
      .sort((a, b) => b.declaredAt - a.declaredAt)

    const seen = new Set<string>()
    const declarations: Declaration[] = []
    for (const { row, declaredAt } of parsed) {
      const county = row.designatedArea ?? ''
      const key = `${row.disasterNumber}:${county}`
      if (seen.has(key)) continue
      seen.add(key)
      // Unparseable end date is treated like null → still active.
      const end = row.incidentEndDate ? Date.parse(row.incidentEndDate) : NaN
      declarations.push({
        disasterNumber: row.disasterNumber as number,
        county,
        incidentType: row.incidentType ?? 'Unknown',
        title: row.declarationTitle ?? '',
        declaredAt,
        active: !Number.isFinite(end) || end > now,
      })
    }
    return { declarations }
  },
}

export default openFema
