import type { FeedAdapter, FeedContext } from '../types.js'

// ---------------------------------------------------------------------------
// NYC DOT / NYCTMC traffic cameras — UNOFFICIAL. webcams.nyctmc.org/api is an
// undocumented internal endpoint with no contract; field names and types have
// already drifted (isOnline is currently the STRING "true"/"false", not a
// boolean). Everything below parses unknown-first with per-field guards and
// expects to break someday — the registry surfaces that as a health warning
// via `unofficial: true` rather than crashing anything.
//
// Observed shape (2026-08): top-level JSON array of
//   { id: uuid, name, latitude: number, longitude: number, area,
//     isOnline: "true"|"false", imageUrl: ".../api/cameras/{id}/image" }
// ---------------------------------------------------------------------------

const CAMERAS_URL = 'https://webcams.nyctmc.org/api/cameras'

export interface DotCamera {
  id: string
  name: string
  lat: number
  lon: number
  online: boolean
  imageUrl: string
}

export interface DotCamerasPayload {
  cameras: DotCamera[]
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

// Accepts real booleans in case the endpoint ever fixes its stringly typing.
function asOnline(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true'
  return false
}

function toCamera(raw: unknown): DotCamera | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>

  const id = asString(r.id)
  if (!id) return null

  const lat = asNumber(r.latitude)
  const lon = asNumber(r.longitude)
  // Drop missing/garbage coordinates, including the 0,0 null-island placeholder.
  if (lat === null || lon === null) return null
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null
  if (lat === 0 && lon === 0) return null

  const imageUrl =
    asString(r.imageUrl) ?? `${CAMERAS_URL}/${encodeURIComponent(id)}/image`

  return {
    id,
    name: asString(r.name) ?? id,
    lat,
    lon,
    online: asOnline(r.isOnline),
    imageUrl,
  }
}

const dotCameras: FeedAdapter<DotCamerasPayload> = {
  capabilityId: 'feeds.dot-cameras',
  id: 'dot-cameras',
  name: 'NYC DOT Traffic Cameras',
  profiles: 'both',
  attribution: 'NYC DOT / NYCTMC',
  refreshIntervalMs: 5 * 60_000,
  unofficial: true,
  push: false, // ~900 cameras citywide — HTTP pull only

  async poll(ctx: FeedContext): Promise<DotCamerasPayload> {
    const body = await ctx.fetchJson(CAMERAS_URL)
    if (!Array.isArray(body)) {
      throw new Error('dot-cameras: expected a JSON array from nyctmc.org (unofficial API changed?)')
    }
    const cameras = body
      .map(toCamera)
      .filter((c): c is DotCamera => c !== null)
    if (cameras.length === 0) {
      throw new Error('dot-cameras: 0 parseable cameras in response (unofficial API changed?)')
    }
    return { cameras }
  },
}

export default dotCameras
