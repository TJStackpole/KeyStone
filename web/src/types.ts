export type IncidentType = 'Structural Fire' | 'Hazmat' | 'Collapse' | 'Mass Casualty'

export const INCIDENT_TYPES: IncidentType[] = ['Structural Fire', 'Hazmat', 'Collapse', 'Mass Casualty']

export interface Incident {
  id: string
  address: string
  bin?: string
  bbl?: string
  borough?: string
  lat: number
  lon: number
  type: IncidentType
  createdAt: string
}

export type ProviderMode = 'keyless' | 'ion' | 'google'

/** Runtime health of each real-data layer, surfaced as chips per the graceful-degradation rule. */
export type LayerStatus = 'idle' | 'loading' | 'ok' | 'unavailable'

export type DataLayerId = 'footprints' | 'pluto' | 'hydrants' | 'firehouses' | 'persistence'

/** Globe layers the operator can toggle from the Site Intel panel. */
export type ToggleLayerId = 'footprints' | 'hydrants' | 'firehouses'

export interface GeoHit {
  label: string
  name: string
  borough?: string
  lon: number
  lat: number
  bin?: string
  bbl?: string
}

// ------------------------------ ICS shapes (Phase 5) ------------------------

export type ZoneKind = 'hot' | 'warm' | 'cold'
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

export type IcsShape = ZoneShape | PostShape

export type DrawTool = ZoneKind | PostKind | null

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
  | 'unknown'

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
  cotType: string
  updatedAt: string
  staleAt: string
}
