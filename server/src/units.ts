import { EventEmitter } from 'node:events'
import {
  agencyFor,
  categorize,
  type Agency,
  type BioTelemetry,
  type CotEvent,
  type UnitCategory,
} from './tak/cot.js'
import { isForeignSimUid } from './sim/ns.js'

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
  /** The event's own time stamp — lets consumers tell a fresh transmission
   *  from the TAK server replaying its latest points (e.g. after a restart). */
  cotTime?: string
}

const STALE_GRACE_MS = 30_000
const SWEEP_INTERVAL_MS = 5_000

/**
 * Live unit picture, built exclusively from CoT events — the registry cannot
 * tell (by design) whether an event came from the simulator or a real phone.
 * Sole exception: sim uids namespaced to a PARALLEL dev stack are dropped at
 * ingest so two stacks sharing one TAK server don't cross-feed (sim/ns.ts).
 *
 * Events: 'unit' (Unit upserted), 'remove' (uid: string)
 */
/** How long an explicit removal suppresses stale CoT echoes for that uid. */
const TOMBSTONE_MS = 10_000

export class UnitRegistry extends EventEmitter {
  private units = new Map<string, Unit>()
  // Explicitly removed uids -> removal time. Sim/drill CoT round-trips through
  // the real TAK server, so an event written to the socket just before a purge
  // echoes back milliseconds after it — without a tombstone that echo silently
  // re-adds the unit and it ghosts until the stale sweep (up to ~10 min).
  private removedAt = new Map<string, number>()

  constructor() {
    super()
    setInterval(() => this.sweep(), SWEEP_INTERVAL_MS).unref()
  }

  all(): Unit[] {
    return [...this.units.values()]
  }

  get(uid: string): Unit | undefined {
    return this.units.get(uid)
  }

  /**
   * Explicit removal (scenario resets) — emits 'remove' like a stale sweep.
   * Tombstones apply ONLY to uids the server itself publishes (sim/drill):
   * they exist to swallow our own in-flight TAK echo, and both timestamps
   * share the server clock there. Real EUDs stamp CoT with the PHONE's clock
   * (often skewed), and they have no server-written events to echo — never
   * tombstone them. `tombstone: false` is for the rewind respawn path, where
   * the same units are re-announced in the same millisecond.
   */
  remove(uid: string, tombstone = true): void {
    if (this.units.delete(uid)) {
      if (tombstone && (uid.startsWith('WT-SIM-') || uid.startsWith('DRILL-'))) {
        this.removedAt.set(uid, Date.now())
      }
      this.emit('remove', uid)
    }
  }

  upsertFromCot(ev: CotEvent): Unit | null {
    // Parallel-dev isolation: a second stack on the same TAK server runs its
    // own simulator under a different uid namespace — its fleet belongs to
    // THAT stack's incident. Real EUD uids never match the sim prefix.
    if (isForeignSimUid(ev.uid)) return null
    const removed = this.removedAt.get(ev.uid)
    if (removed !== undefined) {
      // Only events STAMPED AFTER the removal are legitimate respawns
      // (fresh drill restart, an ATAK phone re-announcing). Undated or
      // pre-removal events are the in-flight echo — drop them.
      const stamped = Date.parse(ev.time ?? ev.start ?? '')
      if (!Number.isFinite(stamped) || stamped <= removed) return null
      this.removedAt.delete(ev.uid)
    }
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
      cotTime: ev.time ?? ev.start,
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
    for (const [uid, t] of this.removedAt) {
      if (now - t > TOMBSTONE_MS) this.removedAt.delete(uid)
    }
  }
}
