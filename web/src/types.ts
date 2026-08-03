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
  | 'lots'
  | 'roads'
  | 'tunnels'
  | 'wind'
  | 'collapsezones'
  | 'battalions'
  | 'divisions'
  | 'poiFirehouses'
  | 'poiFdny'
  | 'poiPrecincts'
  | 'poiHospitals'
  | 'poiNycem'

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
export type PostKind = 'icp' | 'staging' | 'triage' | 'media' | 'transport' | 'hazard' | 'water' | 'fast' | 'exposure'

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
  /** Per-marker text override (e.g. EXP 1..4) — falls back to the kind label. */
  label?: string
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

// ---------------------- Prompt 11: NYCEM coordination -----------------------

export interface PortfolioIncident {
  id: string
  address: string
  borough: string
  lat: number
  lon: number
  type: string
  severity: number
  /** CIMS terminology, exactly: Primary / Supporting Agency. */
  primaryAgency: string
  supportingAgencies: string[]
  /** "Tracked in KeyStone" — never authoritative citywide availability. */
  unitsByAgency: Record<string, number>
  startedAt: string
  source: 'board' | 'scenario' | 'feed'
  alarmLevel?: string
  openRequests: number
  focused: boolean
}

export interface TickerEvent {
  id: string
  ts: string
  kind: string
  text: string
  incidentId?: string
  agency?: string
  borough?: string
  severity?: number
  /** Simulated origin (dispatch feed, drill script) — row shows a SIM chip. */
  sim?: boolean
}

export type EocLevel = 1 | 2 | 3 | 4

export interface EocChange {
  level: EocLevel
  changedBy: string
  changedAt: string
}

export interface PlanActivation {
  id: string
  plan: string
  activatedAt: string
  activatedBy: string
  deactivatedAt?: string
  deactivatedBy?: string
}

export type RequestState = 'opened' | 'acknowledged' | 'assigned' | 'in_progress' | 'complete' | 'declined'
export type RequestPriority = 'routine' | 'urgent' | 'immediate'

export interface InteragencyRequest {
  id: string
  incidentId: string | null
  requestingAgency: string
  assignedAgency: string
  description: string
  priority: RequestPriority
  state: RequestState
  declineReason?: string
  createdBy: string
  createdAt: string
  transitions: { state: string; at: string; by?: string; note?: string }[]
  updates: { at: string; by: string; text: string }[]
}

export interface TriggerRule {
  id: string
  plan: string
  enabled: boolean
  eventMatch: string[]
  suggestedEocLevel: EocLevel
  suggestedActions: string[]
  validateSme: boolean
}

export interface NwsAlert {
  id: string
  event: string
  headline: string
  severity: string
  onset: string | null
  ends: string | null
  areaDesc: string
  polygons: [number, number][][]
  simulated?: boolean
}

export interface TriggerSuggestion {
  id: string
  ruleId: string
  plan: string
  suggestedEocLevel: EocLevel
  suggestedActions: string[]
  firedAt: string
  product: NwsAlert
  state: 'pending' | 'accepted' | 'snoozed' | 'dismissed'
  decidedBy?: string
  decidedAt?: string
  validateSme: boolean
}

export interface WeatherObsNycem {
  stationId: string
  observedAt: string | null
  tempC: number | null
  windKt: number | null
  windDirDeg: number | null
  precipMmHr: number | null
}

export interface AarMetric {
  name: string
  value: string
  detail: string
  sources: string[]
}

export interface AarFinding {
  area: string
  finding: string
  sources: string[]
}

export interface AarDraft {
  title: string
  generatedAt: string
  overview: {
    exerciseName: string
    date: string
    durationMin: number
    scope: string
    participatingAgencies: string[]
  }
  keyEvents: { at: string; text: string }[]
  objectives: { objective: string; observed: string; met: 'met' | 'partial' | 'not observed' }[]
  strengths: AarFinding[]
  improvements: AarFinding[]
  improvementPlan: { item: string; owner: string; deadline: string }[]
  metrics: AarMetric[]
}

export interface ExerciseSession {
  id: string
  scenario: string
  startedAt: string
  endedAt: string
  aar: AarDraft
}

/**
 * One entry of the SIMULATED citywide dispatch feed (FDNY / NYPD / PAPD
 * dispatch centers) — the "other boxes" running around the city, grouped by
 * FDNY division and battalion in the INCIDENTS dropdown.
 */
export interface FeedIncident {
  id: string
  address: string
  borough: string
  lat: number
  lon: number
  type: string
  battalion: number
  division: number
  source: 'FDNY' | 'NYPD' | 'PAPD'
  units: number
  status: 'Dispatched' | 'Operating' | 'Winding Down'
  startedAt: string
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

/**
 * Estimated minutes of SCBA air remaining, derived from the member's own
 * observed burn rate ((4500 − psi) / minutes on air, clamped to a plausible
 * 45–220 psi/min working range). Null when the member has no cylinder data.
 * SIMULATED telemetry — labeled wherever displayed.
 */
export function airMinutesLeft(bio: BioTelemetry): number | null {
  if (bio.airPsi < 0) return null
  const observed = bio.toaMin > 0.5 ? (4500 - bio.airPsi) / bio.toaMin : 90
  const rate = Math.min(220, Math.max(45, observed))
  return bio.airPsi / rate
}

/** Crew a member belongs to: "E-6/1" → "E-6". Vehicles map to themselves. */
export function crewOf(callsign: string): string {
  const i = callsign.indexOf('/')
  return i === -1 ? callsign : callsign.slice(0, i)
}

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
  exercise?: boolean
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
  /** Sender is a simulated unit — badge it SIM (no silent simulation). */
  sim?: boolean
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

// ---- Prompt 13: feed ingestion layer wire types --------------------------

export type FeedStatus = 'ok' | 'stale' | 'down' | 'unconfigured' | 'mock'

export interface FeedHealthWire {
  id: string
  name: string
  status: FeedStatus
  lastSuccess: number | null
  /** Age of the data currently served, ms — stale data ALWAYS shows this. */
  ageMs: number | null
  latencyMs: number | null
  lastError: string | null
  consecutiveFails: number
  refreshIntervalMs: number
  attribution: string
  capabilityId: string
  profiles: 'both' | string[]
  unofficial: boolean
  missingEnv: string[]
  signupUrl: string | null
}

export interface FeedDataWire {
  id: string
  at: number
  payload: unknown
  mock: boolean
  attribution: string
}
