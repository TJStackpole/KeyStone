import { bearingDeg, destination, Polyline, type PathPoint } from '../lib/geo.js'
import { buildCotXml, CATEGORY_COT_TYPE } from '../tak/cot.js'
import { buildFirstAlarm, buildReinforcements, type UnitSpec } from './assignment.js'

const TICK_MS = 2000
const OSRM = 'https://router.project-osrm.org/route/v1/driving'

type Phase = 'enroute' | 'onscene' | 'operating'

interface SimUnit {
  spec: UnitSpec
  uid: string
  path: Polyline
  traveledM: number
  phase: Phase
  /** Turnout time — the unit sits at quarters until this timestamp. */
  departAt: number
  arrivedAt?: number
  /** Drones orbit after arrival. */
  orbit?: { centerLat: number; centerLon: number; radiusM: number; angleDeg: number; degPerTick: number }
  /** Where this unit holds after arrival (NYPD perimeter posts, staging, etc.). */
  holdPoint: PathPoint
}

/** Turnout seconds by category — time from dispatch to wheels rolling. */
const TURNOUT_S: Record<string, [number, number]> = {
  engine: [20, 55],
  ladder: [20, 55],
  battalion: [15, 40],
  rescue: [25, 60],
  ems: [30, 75],
  nypd: [5, 30],
  oem: [60, 120],
  drone: [45, 90],
}

const STATUS_LABEL: Record<Phase, string> = {
  enroute: 'Enroute',
  onscene: 'On Scene',
  operating: 'Operating',
}

/**
 * First-alarm simulator. Publishes genuine CoT XML into the TAK server every
 * 2 s per unit — downstream (our own registry included) cannot distinguish
 * these from a real ATAK client, which is the point.
 */
export class FirstAlarmSimulator {
  private units: SimUnit[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private incident: { lat: number; lon: number } | null = null

  constructor(
    private readonly publish: (xml: string) => boolean,
    private readonly onEvent?: (kind: string, payload?: unknown) => void,
  ) {}

  get active(): boolean {
    return this.timer !== null
  }

  get unitCount(): number {
    return this.units.length
  }

  async dispatch(lat: number, lon: number): Promise<{ callsigns: string[] }> {
    this.stop()
    this.incident = { lat, lon }
    const specs = await buildFirstAlarm(lat, lon)
    this.units = await Promise.all(specs.map((spec) => this.buildSimUnit(spec, lat, lon)))

    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.tick() // first positions immediately

    const callsigns = this.units.map((u) => u.spec.callsign)
    console.log(`[sim] dispatched first alarm: ${callsigns.join(', ')}`)
    this.onEvent?.('sim.dispatched', { callsigns })
    return { callsigns }
  }

  /**
   * Alarm escalation (Phase 8): each level adds reinforcements from the next-
   * nearest real companies not already assigned.
   */
  async escalate(level: 'all-hands' | '2nd' | '3rd'): Promise<{ added: string[] }> {
    if (!this.active || !this.incident) return { added: [] }
    const plan = { 'all-hands': { e: 1, l: 1, bc: 0 }, '2nd': { e: 4, l: 2, bc: 1 }, '3rd': { e: 4, l: 2, bc: 1 } }[level]
    const assigned = new Set(this.units.map((u) => u.spec.callsign))
    const extra = await buildReinforcements(this.incident.lat, this.incident.lon, plan, assigned)
    const built = await Promise.all(extra.map((spec) => this.buildSimUnit(spec, this.incident!.lat, this.incident!.lon)))
    this.units.push(...built)
    const added = built.map((u) => u.spec.callsign)
    console.log(`[sim] ${level} escalation: ${added.join(', ') || 'no companies available'}`)
    this.onEvent?.('sim.escalated', { level, added })
    return { added }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.units = []
  }

  private async buildSimUnit(spec: UnitSpec, incLat: number, incLon: number): Promise<SimUnit> {
    // Fire/EMS stack up at the scene; NYPD holds a loose perimeter short of it;
    // OEM stages a block out.
    let holdPoint: PathPoint = { lat: incLat, lon: incLon }
    if (spec.category === 'nypd') {
      const b = bearingDeg(spec.origin.lat, spec.origin.lon, incLat, incLon)
      holdPoint = destination(incLat, incLon, (b + 180) % 360, 140)
    } else if (spec.category === 'oem') {
      holdPoint = destination(incLat, incLon, 90, 180)
    } else if (spec.category !== 'drone') {
      // spread apparatus around the block face so markers don't stack exactly
      const jitter = Math.random() * 360
      holdPoint = destination(incLat, incLon, jitter, 25 + Math.random() * 45)
    }

    const path =
      spec.category === 'drone'
        ? new Polyline([spec.origin, holdPoint]) // air: direct
        : await this.routeFor(spec.origin, holdPoint)

    const [tMin, tMax] = TURNOUT_S[spec.category] ?? [15, 45]
    const unit: SimUnit = {
      spec,
      uid: `WT-SIM-${spec.callsign}`,
      path,
      traveledM: 0,
      phase: 'enroute',
      departAt: Date.now() + (tMin + Math.random() * (tMax - tMin)) * 1000,
      holdPoint,
    }
    if (spec.category === 'drone') {
      unit.orbit = {
        centerLat: incLat,
        centerLon: incLon,
        radiusM: 90 + Math.random() * 60,
        angleDeg: Math.random() * 360,
        degPerTick: 6 + Math.random() * 4,
      }
    }
    return unit
  }

  /** OSRM public demo router when reachable; grid-plausible L-path fallback. */
  private async routeFor(origin: PathPoint, dest: PathPoint): Promise<Polyline> {
    try {
      const url = `${OSRM}/${origin.lon},${origin.lat};${dest.lon},${dest.lat}?overview=full&geometries=geojson`
      const res = await fetch(url, { signal: AbortSignal.timeout(4000) })
      if (res.ok) {
        const body = (await res.json()) as {
          routes?: { geometry?: { coordinates?: [number, number][] } }[]
        }
        const coords = body.routes?.[0]?.geometry?.coordinates
        if (coords && coords.length >= 2) {
          return new Polyline(coords.map(([lon, lat]) => ({ lat, lon })))
        }
      }
    } catch {
      // demo router down/rate-limited — fall through to the grid path
    }
    // Manhattan-grid approximation: leg along the avenue, then the street.
    const corner = { lat: dest.lat, lon: origin.lon }
    return new Polyline([origin, corner, dest])
  }

  private tick(): void {
    const now = Date.now()
    for (const u of this.units) {
      let lat: number
      let lon: number
      let course = 0
      let speed = 0

      if (u.phase === 'enroute') {
        if (now >= u.departAt) u.traveledM += u.spec.speedMps * (TICK_MS / 1000)
        const pos = u.path.at(u.traveledM)
        lat = pos.lat
        lon = pos.lon
        course = pos.course
        speed = now >= u.departAt ? u.spec.speedMps : 0
        if (u.traveledM >= u.path.totalM) {
          u.phase = 'onscene'
          u.arrivedAt = now
          this.onEvent?.('sim.arrived', { callsign: u.spec.callsign })
          console.log(`[sim] ${u.spec.callsign} on scene`)
        }
      } else if (u.orbit) {
        // Drones: orbit the incident at altitude.
        u.orbit.angleDeg = (u.orbit.angleDeg + u.orbit.degPerTick) % 360
        const p = destination(u.orbit.centerLat, u.orbit.centerLon, u.orbit.angleDeg, u.orbit.radiusM)
        lat = p.lat
        lon = p.lon
        course = (u.orbit.angleDeg + 90) % 360 // tangential heading
        speed = (2 * Math.PI * u.orbit.radiusM * (u.orbit.degPerTick / 360)) / (TICK_MS / 1000)
        u.phase = 'operating'
      } else {
        lat = u.holdPoint.lat
        lon = u.holdPoint.lon
        // Fire/EMS transition On Scene -> Operating after ~25-45 s of setup.
        if (u.phase === 'onscene' && u.arrivedAt && now - u.arrivedAt > 25_000 + Math.random() * 20_000) {
          const opCats = new Set(['engine', 'ladder', 'battalion', 'rescue', 'ems'])
          if (opCats.has(u.spec.category)) {
            u.phase = 'operating'
            console.log(`[sim] ${u.spec.callsign} operating`)
          }
        }
      }

      const status =
        u.spec.category === 'nypd' && u.phase !== 'enroute'
          ? 'Staged'
          : u.spec.category === 'oem' && u.phase !== 'enroute'
            ? 'Staged'
            : STATUS_LABEL[u.phase]

      this.publish(
        buildCotXml({
          uid: u.uid,
          callsign: u.spec.callsign,
          type: CATEGORY_COT_TYPE[u.spec.category],
          lat,
          lon,
          hae: u.spec.category === 'drone' && u.phase !== 'enroute' ? (u.spec.hae ?? 90) : u.spec.category === 'drone' ? climbProfile(u) : 0,
          course,
          speed,
          status,
          staleSeconds: 120,
        }),
      )
    }
  }
}

/** Drones climb linearly toward cruise altitude while enroute. */
function climbProfile(u: SimUnit): number {
  const cruise = u.spec.hae ?? 90
  const progress = u.path.totalM > 0 ? Math.min(1, u.traveledM / u.path.totalM) : 1
  return Math.max(15, cruise * progress)
}
