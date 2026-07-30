import type { IcsShape, PostShape, ZoneShape } from '../types.js'

// ---------------------------------------------------------------------------
// ICS shapes -> CoT, in the dialect ATAK actually renders:
//  - zones  -> "u-d-f" freehand drawing polygons (<link point=.../> vertices,
//              ARGB stroke/fill colors, label via <contact callsign>)
//  - posts  -> "b-m-p-s-m" spot map points with the ICS label as callsign
// Connected ATAK/iTAK clients receive the same perimeter the dashboard shows.
// ---------------------------------------------------------------------------

function esc(v: string): string {
  return v
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** ARGB hex (e.g. 0x66ef4444) as the signed 32-bit int string ATAK expects. */
function argb(hex: number): string {
  return String(hex | 0)
}

const ZONE_STYLE: Record<ZoneShape['zone'], { label: string; stroke: number; fill: number }> = {
  hot: { label: 'HOT ZONE', stroke: 0xffef4444, fill: 0x59ef4444 },
  warm: { label: 'WARM ZONE', stroke: 0xfff59e0b, fill: 0x4df59e0b },
  cold: { label: 'COLD ZONE', stroke: 0xff22c55e, fill: 0x4022c55e },
}

export const POST_LABEL: Record<PostShape['post'], string> = {
  icp: 'ICP',
  staging: 'STAGING AREA',
  triage: 'TRIAGE',
  media: 'MEDIA POINT',
  transport: 'EMS TRANSPORT CORRIDOR',
}

function isoTimes(staleSeconds: number): string {
  const now = new Date()
  const stale = new Date(now.getTime() + staleSeconds * 1000)
  return `time="${now.toISOString()}" start="${now.toISOString()}" stale="${stale.toISOString()}"`
}

/** Long-lived events: shapes should survive on ATAK screens for the incident. */
const SHAPE_STALE_S = 24 * 3600

export function shapeToCot(shape: IcsShape): string {
  if (shape.kind === 'zone') return zoneToCot(shape)
  if (shape.kind === 'apparatus') return apparatusToCot(shape)
  return postToCot(shape)
}

/** Staging reservations publish as spot markers named for the incoming unit. */
function apparatusToCot(shape: Extract<IcsShape, { kind: 'apparatus' }>): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<event version="2.0" uid="${esc(shape.id)}" type="b-m-p-s-m" how="h-g-i-g-o" ${isoTimes(SHAPE_STALE_S)}>` +
    `<point lat="${shape.lat.toFixed(7)}" lon="${shape.lon.toFixed(7)}" hae="0.0" ce="9999999.0" le="9999999.0"/>` +
    `<detail>` +
    `<contact callsign="STAGE ${esc(shape.callsign)}"/>` +
    `<archive/>` +
    `</detail>` +
    `</event>\n`
  )
}

function zoneToCot(zone: ZoneShape): string {
  const style = ZONE_STYLE[zone.zone]
  const first = zone.positions[0]
  const links = zone.positions
    .map((p) => `<link point="${p.lat.toFixed(7)},${p.lon.toFixed(7)}"/>`)
    .join('')
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<event version="2.0" uid="${esc(zone.id)}" type="u-d-f" how="h-e" ${isoTimes(SHAPE_STALE_S)}>` +
    `<point lat="${first.lat.toFixed(7)}" lon="${first.lon.toFixed(7)}" hae="0.0" ce="9999999.0" le="9999999.0"/>` +
    `<detail>` +
    links +
    `<strokeColor value="${argb(style.stroke)}"/>` +
    `<strokeWeight value="2.0"/>` +
    `<fillColor value="${argb(style.fill)}"/>` +
    `<contact callsign="${esc(style.label)}"/>` +
    `<labels_on value="true"/>` +
    `<archive/>` +
    `</detail>` +
    `</event>\n`
  )
}

function postToCot(post: PostShape): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<event version="2.0" uid="${esc(post.id)}" type="b-m-p-s-m" how="h-g-i-g-o" ${isoTimes(SHAPE_STALE_S)}>` +
    `<point lat="${post.lat.toFixed(7)}" lon="${post.lon.toFixed(7)}" hae="0.0" ce="9999999.0" le="9999999.0"/>` +
    `<detail>` +
    `<contact callsign="${esc(POST_LABEL[post.post])}"/>` +
    `<status readiness="true"/>` +
    `<archive/>` +
    `</detail>` +
    `</event>\n`
  )
}

/** ATAK deletion convention: a t-x-d-d tasking event naming the removed uid. */
export function shapeDeleteCot(id: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<event version="2.0" uid="${esc(id)}-delete" type="t-x-d-d" how="h-e" ${isoTimes(60)}>` +
    `<point lat="0" lon="0" hae="0" ce="9999999.0" le="9999999.0"/>` +
    `<detail><link uid="${esc(id)}" relation="none" type="none"/><__forcedelete/></detail>` +
    `</event>\n`
  )
}
