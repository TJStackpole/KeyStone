export type IncidentType = 'Structural Fire' | 'Hazmat' | 'Collapse' | 'Mass Casualty'

export type AlarmLevel = '10-75' | 'all-hands' | '2nd' | '3rd'

export interface Incident {
  id: string
  /** Display label, e.g. "100 GOLD STREET, New York, NY, USA" */
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

export interface TimelineEvent {
  t: string
  kind: string
  payload?: unknown
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

/** Envelope persisted to data/incident.json. */
export interface IncidentFile {
  incident: Incident | null
  shapes: IcsShape[]
  timeline: TimelineEvent[]
}
