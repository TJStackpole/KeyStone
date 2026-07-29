export type IncidentType = 'Structural Fire' | 'Hazmat' | 'Collapse' | 'Mass Casualty'

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
  createdAt: string
}

export interface TimelineEvent {
  t: string
  kind: string
  payload?: unknown
}

/** Envelope persisted to data/incident.json. Shapes arrive in Phase 5, timeline grows from Phase 1 on. */
export interface IncidentFile {
  incident: Incident | null
  shapes: unknown[]
  timeline: TimelineEvent[]
}
