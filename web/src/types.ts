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
export type ToggleLayerId =
  | 'footprints'
  | 'targetbox'
  | 'hydrants'
  | 'firehouses'
  | 'streets'
  | 'traffic'
  | 'battalions'
  | 'divisions'

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

export type DrawTool = ZoneKind | PostKind | 'measure' | 'collapse' | 'apparatus' | 'ground' | null

// ------------------------------ comms (Phase 7) -----------------------------

export type LiveChannel = 'fdny' | 'nypd' | 'ems' | 'oem'
export type ScenarioChannel = 'fdny-tac' | 'fdny-cmd' | 'ems-cw' | 'nypd-sod' | 'papd' | 'interagency'
export type CommsChannel = LiveChannel | ScenarioChannel

export interface TranscriptKeyword {
  kind: 'unit' | 'code' | 'urgent' | 'address'
  text: string
  callsign?: string
}

export interface TranscriptLine {
  /** Unique per line (same-ms lines are routine). Optional only so a stale
   * dev server without ids degrades gracefully during HMR. */
  id?: string
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
  | 'papd'
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

export type Agency = 'FDNY' | 'EMS' | 'NYPD' | 'PAPD' | 'OEM' | 'TAK'

// ------------------------------ scenario (8A) -------------------------------

export interface ScenarioChapter {
  id: string
  t: number
  title: string
}

export interface ScenarioStatus {
  loaded: boolean
  name: string | null
  drill: boolean
  playing: boolean
  speed: number
  clock: number
  duration: number
  chapters: ScenarioChapter[]
}

export interface MapAlert {
  kind: string
  callsign?: string
  uid?: string
  lat?: number
  lon?: number
  text?: string
  at?: string
}

export interface ExposureLabel {
  text: string
  lat: number
  lon: number
}

/** TAK GeoChat message (b-t-f CoT, "All Chat Rooms"). */
export interface ChatMsg {
  id: string
  from: string
  room: string
  text: string
  ts: string
  self?: boolean
}

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
