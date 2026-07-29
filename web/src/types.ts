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
