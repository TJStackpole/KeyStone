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

/** Envelope persisted to data/incident.json. */
export interface IncidentFile {
  incident: Incident | null
  shapes: IcsShape[]
  timeline: TimelineEvent[]
}
