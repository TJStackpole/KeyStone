import { EventEmitter } from 'node:events'
import {
  agencyFor,
  categorize,
  type Agency,
  type BioTelemetry,
  type CotEvent,
  type UnitCategory,
} from './tak/cot.js'

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
  /** Building floor (1-based; 0/undefined = exterior). */
  floor?: number
  bio?: BioTelemetry
  cotType: string
  updatedAt: string
  staleAt: string
}

const STALE_GRACE_MS = 30_000
const SWEEP_INTERVAL_MS = 5_000

/**
 * Live unit picture, built exclusively from CoT events — the registry cannot
 * tell (by design) whether an event came from the simulator or a real phone.
 *
 * Events: 'unit' (Unit upserted), 'remove' (uid: string)
 */
export class UnitRegistry extends EventEmitter {
  private units = new Map<string, Unit>()

  constructor() {
    super()
    setInterval(() => this.sweep(), SWEEP_INTERVAL_MS).unref()
  }

  all(): Unit[] {
    return [...this.units.values()]
  }

  /** Explicit removal (scenario resets) — emits 'remove' like a stale sweep. */
  remove(uid: string): void {
    if (this.units.delete(uid)) this.emit('remove', uid)
  }

  upsertFromCot(ev: CotEvent): Unit {
    const existing = this.units.get(ev.uid)
    const callsign = ev.callsign ?? existing?.callsign ?? ev.uid
    const category = categorize(callsign, ev.type, ev.role)
    const staleAt =
      ev.stale && !Number.isNaN(Date.parse(ev.stale))
        ? ev.stale
        : new Date(Date.now() + 120_000).toISOString()

    const unit: Unit = {
      uid: ev.uid,
      callsign,
      category,
      agency: agencyFor(category),
      lat: ev.lat,
      lon: ev.lon,
      hae: ev.hae,
      course: ev.course ?? existing?.course,
      speed: ev.speed ?? existing?.speed,
      status: ev.status ?? existing?.status,
      floor: ev.floor ?? existing?.floor,
      bio: ev.bio ?? existing?.bio,
      cotType: ev.type,
      updatedAt: new Date().toISOString(),
      staleAt,
    }
    this.units.set(ev.uid, unit)
    this.emit('unit', unit)
    return unit
  }

  private sweep(): void {
    const now = Date.now()
    for (const [uid, unit] of this.units) {
      if (now > Date.parse(unit.staleAt) + STALE_GRACE_MS) {
        this.units.delete(uid)
        this.emit('remove', uid)
        console.log(`[units] ${unit.callsign} (${uid}) went stale — removed`)
      }
    }
  }
}
