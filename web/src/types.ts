export type IncidentType = 'Structural Fire' | 'Hazmat' | 'Collapse' | 'Mass Casualty'

export const INCIDENT_TYPES: IncidentType[] = ['Structural Fire', 'Hazmat', 'Collapse', 'Mass Casualty']

export type AlarmLevel = '10-75' | 'all-hands' | '2nd' | '3rd'

export interface Incident {
  id: string
  address: string
  bin?: string
  bbl?: string
  borough?: string
  lat: number
  lon: number
  type: IncidentType
  alarmLevel?: AlarmLevel
  createdAt: string
}

export type ProviderMode = 'keyless' | 'ion' | 'google'

/** Runtime health of each real-data layer, surfaced as chips per the graceful-degradation rule. */
export type LayerStatus = 'idle' | 'loading' | 'ok' | 'unavailable'

export type DataLayerId = 'footprints' | 'pluto' | 'hydrants' | 'firehouses' | 'safety' | 'persistence'

/** Globe layers the operator can toggle from the Site Intel panel. */
export type ToggleLayerId = 'footprints' | 'hydrants' | 'firehouses' | 'battalions' | 'divisions'

export interface GeoHit {
  label: string
  name: string
  borough?: string
  neighbourhood?: string
  lon: number
  lat: number
  bin?: string
  bbl?: string
}

// ------------------------------ ICS shapes (Phase 5) ------------------------

export type ZoneKind = 'hot' | 'warm' | 'cold' | 'perimeter'
export type PostKind = 'icp' | 'staging' | 'triage' | 'media' | 'transport'

export interface ZoneShape {
  id: string
  kind: 'zone'
  zone: ZoneKind
  positions: { lat: number; lon: number }[]
  createdAt: string
}

export interface PostShape {
  id: string
  kind: 'post'
  post: PostKind
  lat: number
  lon: number
  createdAt: string
}

/** Chief's staging tool: a true-scale apparatus footprint reserved for an incoming unit. */
export interface ApparatusShape {
  id: string
  kind: 'apparatus'
  callsign: string
  lat: number
  lon: number
  /** Degrees true — the footprint is drawn along this axis. */
  heading: number
  /** Height above ellipsoid of the clicked surface, so the pad renders flat (no facade drape). */
  hae?: number
  createdAt: string
}

export type IcsShape = ZoneShape | PostShape | ApparatusShape

export type DrawTool = ZoneKind | PostKind | 'measure' | 'collapse' | 'apparatus' | null

// ------------------------------ comms (Phase 7) -----------------------------

export type CommsChannel = 'fdny' | 'nypd' | 'ems' | 'oem'

export interface TranscriptKeyword {
  kind: 'unit' | 'code' | 'urgent' | 'address'
  text: string
  callsign?: string
}

export interface TranscriptLine {
  ts: string
  text: string
  keywords: TranscriptKeyword[]
  live: boolean
}

export interface CommsConfig {
  live: boolean
  audioUrl: string
}

export interface TimelineEvent {
  t: string
  kind: string
  payload?: unknown
}

// ------------------------------ units (Phase 3+) ----------------------------

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
  | 'ff'
  | 'officer'
  | 'medic'
  | 'unknown'

/** Personnel biometric telemetry (SIMULATED; carried in CoT detail). */
export interface BioTelemetry {
  hr: number
  airPsi: number
  tempC: number
  toaMin: number
}

export type BioStatus = 'ok' | 'caution' | 'rotate'

export function bioStatusOf(bio: BioTelemetry): BioStatus {
  if (bio.hr >= 178 || (bio.airPsi >= 0 && bio.airPsi <= 1100) || bio.tempC >= 38.5 || bio.toaMin >= 22) {
    return 'rotate'
  }
  if (bio.hr >= 160 || (bio.airPsi >= 0 && bio.airPsi <= 1800) || bio.tempC >= 38.0 || bio.toaMin >= 16) {
    return 'caution'
  }
  return 'ok'
}

export type Agency = 'FDNY' | 'EMS' | 'NYPD' | 'OEM' | 'TAK'

export type UnitStatus = 'Enroute' | 'On Scene' | 'Staged' | 'Operating'

export interface Unit {
  uid: string
  callsign: string
  category: UnitCategory
  agency: Agency
  lat: number
  lon: number
  hae: number
  course?: number
  speed?: number
  status?: string
  /** Building floor for interior members (1-based; 0/undefined = exterior). */
  floor?: number
  bio?: BioTelemetry
  cotType: string
  updatedAt: string
  staleAt: string
}
