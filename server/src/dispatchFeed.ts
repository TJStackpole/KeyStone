import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// SIMULATED citywide dispatch feed — the "other boxes" running around the
// city, as fed to KeyStone by the FDNY borough dispatch offices, NYPD
// dispatch, and Port Authority police desk. Every entry is SIMULATED and
// labeled so in the UI; locations are real NYC addresses with plausible
// FDNY battalion/division attribution so the division→battalion breakdown
// demos correctly. A production deployment would ingest each agency's real
// CAD feed here instead (same shape, same fan-out).
// ---------------------------------------------------------------------------

export type FeedSource = 'FDNY' | 'NYPD' | 'PAPD'

export interface FeedIncident {
  id: string
  address: string
  borough: string
  lat: number
  lon: number
  type: string
  /** FDNY battalion number the box falls in (SIMULATED attribution). */
  battalion: number
  /** FDNY division number (SIMULATED attribution). */
  division: number
  /** Originating dispatch center. */
  source: FeedSource
  /** Responding-unit count reported by the dispatch center. */
  units: number
  status: 'Dispatched' | 'Operating' | 'Winding Down'
  startedAt: string
}

interface PoolEntry {
  address: string
  borough: string
  lat: number
  lon: number
  battalion: number
  division: number
  source: FeedSource
  types: string[]
}

const FDNY_TYPES = ['Structural Fire', 'Gas Leak', 'Food on the Stove', 'Rubbish Fire', 'Water Condition', 'Automatic Alarm']
const NYPD_TYPES = ['MVA with Injuries — FD Assist', 'Crowd Condition — FD Standby', 'EDP — FD Assist']

const POOL: PoolEntry[] = [
  { address: '90 West Street', borough: 'Manhattan', lat: 40.7093, lon: -74.0138, battalion: 1, division: 1, source: 'FDNY', types: FDNY_TYPES },
  { address: '130 Fulton Street', borough: 'Manhattan', lat: 40.7103, lon: -74.0074, battalion: 1, division: 1, source: 'FDNY', types: FDNY_TYPES },
  { address: '325 Broadway', borough: 'Manhattan', lat: 40.716, lon: -74.0051, battalion: 2, division: 1, source: 'FDNY', types: FDNY_TYPES },
  { address: '265 Canal Street', borough: 'Manhattan', lat: 40.7186, lon: -74.0016, battalion: 2, division: 1, source: 'FDNY', types: FDNY_TYPES },
  { address: '1 Centre Street', borough: 'Manhattan', lat: 40.7128, lon: -74.0027, battalion: 1, division: 1, source: 'NYPD', types: NYPD_TYPES },
  { address: 'Holland Tunnel NY Approach', borough: 'Manhattan', lat: 40.7256, lon: -74.0119, battalion: 2, division: 1, source: 'PAPD', types: ['Vehicle Fire — Tunnel Approach', 'Disabled Truck — Lane Closure'] },
  { address: '350 5th Avenue', borough: 'Manhattan', lat: 40.7484, lon: -73.9857, battalion: 7, division: 3, source: 'FDNY', types: FDNY_TYPES },
  { address: '525 West 42nd Street', borough: 'Manhattan', lat: 40.7597, lon: -73.9963, battalion: 9, division: 3, source: 'FDNY', types: FDNY_TYPES },
  { address: 'Port Authority Bus Terminal', borough: 'Manhattan', lat: 40.757, lon: -73.991, battalion: 9, division: 3, source: 'PAPD', types: ['Unattended Package — FD Standby', 'Terminal Medical — EMS Assist', 'Escalator Entrapment'] },
  { address: 'GWB Bus Station', borough: 'Manhattan', lat: 40.8489, lon: -73.9397, battalion: 13, division: 3, source: 'PAPD', types: ['Unattended Package — FD Standby', 'Terminal Medical — EMS Assist'] },
  { address: '2856 Grand Concourse', borough: 'Bronx', lat: 40.8672, lon: -73.8935, battalion: 19, division: 7, source: 'FDNY', types: FDNY_TYPES },
  { address: 'E 149th St & Grand Concourse', borough: 'Bronx', lat: 40.8183, lon: -73.9272, battalion: 17, division: 6, source: 'NYPD', types: NYPD_TYPES },
  { address: '890 Garrison Avenue', borough: 'Bronx', lat: 40.8177, lon: -73.8921, battalion: 3, division: 6, source: 'FDNY', types: FDNY_TYPES },
  { address: '180 Montague Street', borough: 'Brooklyn', lat: 40.694, lon: -73.9922, battalion: 31, division: 11, source: 'FDNY', types: FDNY_TYPES },
  { address: '620 Atlantic Avenue', borough: 'Brooklyn', lat: 40.6839, lon: -73.9767, battalion: 38, division: 11, source: 'NYPD', types: NYPD_TYPES },
  { address: '1274 Bedford Avenue', borough: 'Brooklyn', lat: 40.6797, lon: -73.9528, battalion: 57, division: 15, source: 'FDNY', types: FDNY_TYPES },
  { address: '30-02 Steinway Street', borough: 'Queens', lat: 40.7638, lon: -73.9155, battalion: 49, division: 14, source: 'FDNY', types: FDNY_TYPES },
  { address: 'LaGuardia Airport Terminal B', borough: 'Queens', lat: 40.774, lon: -73.8726, battalion: 49, division: 14, source: 'PAPD', types: ['Aircraft Standby — Precautionary', 'Terminal Medical — EMS Assist', 'Vehicle Fire — Parking Structure'] },
  { address: '89-61 162nd Street', borough: 'Queens', lat: 40.706, lon: -73.799, battalion: 50, division: 13, source: 'FDNY', types: FDNY_TYPES },
  { address: '475 Bay Street', borough: 'Staten Island', lat: 40.628, lon: -74.0766, battalion: 21, division: 8, source: 'FDNY', types: FDNY_TYPES },
]

const TICK_MS = 25_000
const MIN_ACTIVE = 5
const MAX_ACTIVE = 8
/** Feed incidents live 6–18 minutes, then close. */
const lifespanMs = () => (6 + Math.random() * 12) * 60_000

interface ActiveEntry {
  incident: FeedIncident
  diesAt: number
}

/** Rotating simulated citywide incident list. Emits 'update' with the list. */
export class DispatchFeed extends EventEmitter {
  private active = new Map<string, ActiveEntry>()
  private nextId = 1

  start(): void {
    while (this.active.size < MIN_ACTIVE + 1) this.spawn()
    setInterval(() => this.tick(), TICK_MS).unref?.()
    this.emit('update', this.all())
  }

  all(): FeedIncident[] {
    return [...this.active.values()].map((a) => a.incident)
  }

  private spawn(): void {
    const activeAddrs = new Set([...this.active.values()].map((a) => a.incident.address))
    const candidates = POOL.filter((p) => !activeAddrs.has(p.address))
    if (!candidates.length) return
    const p = candidates[Math.floor(Math.random() * candidates.length)]
    const id = `FEED-${this.nextId++}`
    this.active.set(id, {
      incident: {
        id,
        address: p.address,
        borough: p.borough,
        lat: p.lat,
        lon: p.lon,
        type: p.types[Math.floor(Math.random() * p.types.length)],
        battalion: p.battalion,
        division: p.division,
        source: p.source,
        units: 2 + Math.floor(Math.random() * 5),
        status: 'Dispatched',
        startedAt: new Date().toISOString(),
      },
      diesAt: Date.now() + lifespanMs(),
    })
  }

  private tick(): void {
    const now = Date.now()
    let changed = false
    for (const [id, entry] of this.active) {
      if (now >= entry.diesAt) {
        this.active.delete(id)
        changed = true
        continue
      }
      const inc = entry.incident
      const ageMs = now - Date.parse(inc.startedAt)
      const frac = ageMs / (entry.diesAt - Date.parse(inc.startedAt))
      const status: FeedIncident['status'] = ageMs < 120_000 ? 'Dispatched' : frac > 0.75 ? 'Winding Down' : 'Operating'
      if (status !== inc.status) {
        inc.status = status
        changed = true
      }
      // Unit counts drift as the box escalates / units take up.
      if (Math.random() < 0.3) {
        const delta = status === 'Winding Down' ? -1 : Math.random() < 0.6 ? 1 : -1
        const next = Math.max(1, Math.min(12, inc.units + delta))
        if (next !== inc.units) {
          inc.units = next
          changed = true
        }
      }
    }
    if (this.active.size < MIN_ACTIVE || (this.active.size < MAX_ACTIVE && Math.random() < 0.35)) {
      this.spawn()
      changed = true
    }
    if (changed) this.emit('update', this.all())
  }
}
