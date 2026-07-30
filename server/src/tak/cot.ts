import { XMLParser } from 'fast-xml-parser'

// ---------------------------------------------------------------------------
// Cursor-on-Target (CoT) — genuine event XML, the lingua franca of TAK.
// Every unit position in KEYSTONE round-trips through a real TAK server as
// one of these events; a real ATAK phone's traffic parses identically.
// ---------------------------------------------------------------------------

/** Personnel biometric telemetry (KEYSTONE CoT detail extension). */
export interface BioTelemetry {
  /** Heart rate, bpm. */
  hr: number
  /** SCBA cylinder pressure, psi (FDNY members only; -1 = no SCBA). */
  airPsi: number
  /** Core temperature, °C. */
  tempC: number
  /** Time on air / in operation, minutes. */
  toaMin: number
}

export interface CotEvent {
  uid: string
  /** CoT type atom, e.g. "a-f-G-E-V-F" (atom-friendly-Ground-Equipment-Vehicle-Fire). */
  type: string
  how?: string
  time?: string
  start?: string
  stale?: string
  lat: number
  lon: number
  /** Height above ellipsoid, meters. */
  hae: number
  callsign?: string
  group?: string
  /** Track course, degrees true. */
  course?: number
  /** Track speed, m/s. */
  speed?: number
  /** KEYSTONE extension: operational status carried in <detail>. */
  status?: string
  /** KEYSTONE extension: personnel role (ff | officer | medic). */
  role?: string
  /** KEYSTONE extension: building floor (1-based; 0/absent = exterior). */
  floor?: number
  /** KEYSTONE extension: personnel biometrics. */
  bio?: BioTelemetry
  /** Original XML as received (proof-of-protocol logging, replay). */
  raw?: string
}

// -------------------------- unit taxonomy mapping ---------------------------

export type UnitCategory =
  | 'engine'
  | 'ladder'
  | 'battalion'
  | 'rescue'
  | 'ems'
  | 'nypd'
  | 'esu'
  | 'oem'
  | 'drone'
  | 'ff' // FDNY member on foot
  | 'officer' // NYPD member on foot
  | 'medic' // EMS member on foot
  | 'unknown'

export type Agency = 'FDNY' | 'EMS' | 'NYPD' | 'OEM' | 'TAK'

/** Callsign-prefix convention (primary signal — survives generic ATAK type atoms). */
const CALLSIGN_RULES: [RegExp, UnitCategory][] = [
  [/^(ESU)[- ]?\d/i, 'esu'],
  [/^(EMS|MED|M)[- ]?\d/i, 'ems'],
  [/^(E|ENG|ENGINE)[- ]?\d/i, 'engine'],
  [/^(L|LAD|LADDER|TL)[- ]?\d/i, 'ladder'],
  [/^(BC|BN|BATT|DIV|CAR)[- ]?\d/i, 'battalion'],
  [/^(R|RES|RESCUE|SQ|SQUAD)[- ]?\d/i, 'rescue'],
  [/^(PD|NYPD|SEC|SECTOR|ADAM|BOY)[- ]?\d/i, 'nypd'],
  [/^(OEM|EOC)[- ]?\d/i, 'oem'],
  [/^(UAS|UAV|DRONE|DR)[- ]?\d/i, 'drone'],
]

/** CoT type atoms KEYSTONE publishes per category (MIL-STD-2525 friendly framing). */
export const CATEGORY_COT_TYPE: Record<UnitCategory, string> = {
  engine: 'a-f-G-E-V-F',
  ladder: 'a-f-G-E-V-F',
  battalion: 'a-f-G-U-C',
  rescue: 'a-f-G-E-V-F',
  ems: 'a-f-G-E-V-m',
  nypd: 'a-f-G-E-V-p',
  esu: 'a-f-G-E-V-p',
  oem: 'a-f-G-U-C',
  drone: 'a-f-A-M-F-Q',
  ff: 'a-f-G-U-C-I', // dismounted individual
  officer: 'a-f-G-U-C-I',
  medic: 'a-f-G-U-C-I',
  unknown: 'a-f-G-U-C',
}

const ROLE_CATEGORY: Record<string, UnitCategory> = {
  ff: 'ff',
  officer: 'officer',
  medic: 'medic',
}

export function categorize(callsign: string | undefined, cotType: string, role?: string): UnitCategory {
  // Personnel role (KEYSTONE extension) wins — dismounted members carry the
  // same designator family as their apparatus, so callsign rules would misfile them.
  if (role && ROLE_CATEGORY[role]) return ROLE_CATEGORY[role]
  if (callsign) {
    for (const [re, cat] of CALLSIGN_RULES) {
      if (re.test(callsign.trim())) return cat
    }
  }
  if (cotType.startsWith('a-f-A-M-F-Q') || cotType.startsWith('a-f-A')) return 'drone'
  if (cotType.startsWith('a-f-G-E-V-m')) return 'ems'
  if (cotType.startsWith('a-f-G-E-V-p')) return 'nypd'
  if (cotType.startsWith('a-f-G-E-V-F')) return 'engine'
  return 'unknown'
}

export function agencyFor(category: UnitCategory): Agency {
  switch (category) {
    case 'engine':
    case 'ladder':
    case 'battalion':
    case 'rescue':
    case 'drone':
    case 'ff':
      return 'FDNY'
    case 'ems':
    case 'medic':
      return 'EMS'
    case 'nypd':
    case 'esu':
    case 'officer':
      return 'NYPD'
    case 'oem':
      return 'OEM'
    default:
      return 'TAK'
  }
}

// ------------------------------- XML building -------------------------------

function esc(v: string): string {
  return v
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export interface BuildCotOptions {
  uid: string
  callsign: string
  type: string
  lat: number
  lon: number
  hae?: number
  course?: number
  speed?: number
  status?: string
  role?: string
  floor?: number
  bio?: BioTelemetry
  group?: string
  staleSeconds?: number
}

/** Well-formed CoT event XML, newline-terminated for TCP streaming. */
export function buildCotXml(o: BuildCotOptions): string {
  const now = new Date()
  const stale = new Date(now.getTime() + (o.staleSeconds ?? 120) * 1000)
  const iso = (d: Date) => d.toISOString()
  const hae = o.hae ?? 0

  let detail = `<contact callsign="${esc(o.callsign)}"/>`
  detail += `<__group name="${esc(o.group ?? 'Blue')}" role="Team Member"/>`
  if (o.course !== undefined || o.speed !== undefined) {
    detail += `<track course="${(o.course ?? 0).toFixed(1)}" speed="${(o.speed ?? 0).toFixed(1)}"/>`
  }
  if (o.status || o.role || o.bio) {
    // KEYSTONE extension element — unknown detail children are legal CoT and
    // pass through TAK servers untouched; ATAK simply ignores them.
    let ext = '<keystone'
    if (o.status) ext += ` status="${esc(o.status)}"`
    if (o.role) ext += ` role="${esc(o.role)}"`
    if (o.floor !== undefined) ext += ` floor="${Math.round(o.floor)}"`
    if (o.bio) {
      ext += ` hr="${Math.round(o.bio.hr)}" air="${Math.round(o.bio.airPsi)}"`
      ext += ` temp="${o.bio.tempC.toFixed(1)}" toa="${o.bio.toaMin.toFixed(1)}"`
    }
    detail += `${ext}/>`
  }

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<event version="2.0" uid="${esc(o.uid)}" type="${esc(o.type)}" how="m-g"` +
    ` time="${iso(now)}" start="${iso(now)}" stale="${iso(stale)}">` +
    `<point lat="${o.lat.toFixed(7)}" lon="${o.lon.toFixed(7)}" hae="${hae.toFixed(1)}" ce="9999999.0" le="9999999.0"/>` +
    `<detail>${detail}</detail>` +
    `</event>\n`
  )
}

// ------------------------------- XML parsing --------------------------------

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  ignoreDeclaration: true,
})

interface ParsedAttrs {
  [key: string]: unknown
}

function attr(node: unknown, name: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined
  const v = (node as ParsedAttrs)[`@_${name}`]
  return v === undefined ? undefined : String(v)
}

function firstNode(node: unknown): unknown {
  return Array.isArray(node) ? node[0] : node
}

/** Parse one CoT <event> XML document. Returns null for non-events/marti noise. */
export function parseCotXml(xml: string): CotEvent | null {
  let doc: ParsedAttrs
  try {
    doc = parser.parse(xml) as ParsedAttrs
  } catch {
    return null
  }
  const event = firstNode(doc.event)
  if (!event || typeof event !== 'object') return null

  const uid = attr(event, 'uid')
  const type = attr(event, 'type')
  const point = firstNode((event as ParsedAttrs).point)
  const lat = Number(attr(point, 'lat'))
  const lon = Number(attr(point, 'lon'))
  if (!uid || !type || !Number.isFinite(lat) || !Number.isFinite(lon)) return null

  const detail = firstNode((event as ParsedAttrs).detail)
  const contact = detail ? firstNode((detail as ParsedAttrs).contact) : undefined
  const track = detail ? firstNode((detail as ParsedAttrs).track) : undefined
  const group = detail ? firstNode((detail as ParsedAttrs)['__group']) : undefined
  // Read the KEYSTONE extension; fall back to the legacy <watchtower> tag so
  // older publishers (pre-rebrand test scripts) keep working.
  const watchtower = detail
    ? (firstNode((detail as ParsedAttrs).keystone) ?? firstNode((detail as ParsedAttrs).watchtower))
    : undefined

  const course = track ? Number(attr(track, 'course')) : NaN
  const speed = track ? Number(attr(track, 'speed')) : NaN

  let bio: BioTelemetry | undefined
  if (watchtower && attr(watchtower, 'hr') !== undefined) {
    bio = {
      hr: Number(attr(watchtower, 'hr')),
      airPsi: Number(attr(watchtower, 'air') ?? -1),
      tempC: Number(attr(watchtower, 'temp') ?? 37),
      toaMin: Number(attr(watchtower, 'toa') ?? 0),
    }
  }

  return {
    uid,
    type,
    how: attr(event, 'how'),
    time: attr(event, 'time'),
    start: attr(event, 'start'),
    stale: attr(event, 'stale'),
    lat,
    lon,
    hae: Number(attr(point, 'hae')) || 0,
    callsign: contact ? attr(contact, 'callsign') : undefined,
    group: group ? attr(group, 'name') : undefined,
    course: Number.isFinite(course) ? course : undefined,
    speed: Number.isFinite(speed) ? speed : undefined,
    status: watchtower ? attr(watchtower, 'status') : undefined,
    role: watchtower ? attr(watchtower, 'role') : undefined,
    floor: watchtower && attr(watchtower, 'floor') !== undefined ? Number(attr(watchtower, 'floor')) : undefined,
    bio,
    raw: xml,
  }
}

/** True for "atom" (unit/track) events — the ones that belong in the unit registry. */
export function isUnitEvent(ev: CotEvent): boolean {
  // a-* = atoms. Excludes tasking (t-*), bits (b-*), capability (c-*), etc.
  // Also excludes TAK server ping/pong chatter.
  return ev.type.startsWith('a-') && !ev.uid.endsWith('-ping')
}
