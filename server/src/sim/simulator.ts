import { bearingDeg, destination, Polyline, type PathPoint } from '../lib/geo.js'
import { buildCotXml, CATEGORY_COT_TYPE, type BioTelemetry } from '../tak/cot.js'
import { buildFirstAlarm, buildReinforcements, type UnitSpec } from './assignment.js'

const TICK_MS = 2000
const OSRM = 'https://router.project-osrm.org/route/v1/driving'

type Phase = 'enroute' | 'onscene' | 'operating'

// ---------------------------------------------------------------------------
// Personnel: dismounted members spawned when their apparatus arrives, tracked
// individually (GPS wander on foot) with simulated biometric telemetry that
// drives rotation advisories on the dashboard. SIMULATED data end to end.
// ---------------------------------------------------------------------------
type PersonnelRole = 'ff' | 'officer' | 'medic'

interface SimPerson {
  uid: string
  callsign: string
  role: PersonnelRole
  parentCallsign: string
  /** Anchor they operate around (building face / perimeter post / triage). */
  anchor: PathPoint
  pos: PathPoint
  target: PathPoint
  walkSpeed: number
  pauseTicks: number
  startedAt: number
  bio: BioTelemetry
  /** Members flagged ROTATE walk back to their rig and go Rehab. */
  rotating: boolean
}

const CREW_SIZE: Partial<Record<string, number>> = {
  engine: 2,
  ladder: 2,
  rescue: 2,
  battalion: 1,
  nypd: 1,
  ems: 1,
}

function roleFor(category: string): PersonnelRole | null {
  if (category === 'engine' || category === 'ladder' || category === 'rescue' || category === 'battalion') return 'ff'
  if (category === 'nypd') return 'officer'
  if (category === 'ems') return 'medic'
  return null
}

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
  private personnel: SimPerson[] = []
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
    this.personnel = []
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

  /** Dismount the crew when an apparatus arrives (tracked individually). */
  private spawnCrew(u: SimUnit): void {
    if (!this.incident) return
    const count = CREW_SIZE[u.spec.category] ?? 0
    const role = roleFor(u.spec.category)
    if (!count || !role) return
    for (let i = 0; i < count; i++) {
      // FDNY members work the building face; officers hold their perimeter
      // post; medics run between the rigs and the patient side.
      const anchor =
        role === 'ff'
          ? destination(this.incident.lat, this.incident.lon, Math.random() * 360, 12 + Math.random() * 25)
          : role === 'officer'
            ? u.holdPoint
            : destination(u.holdPoint.lat, u.holdPoint.lon, Math.random() * 360, 15)
      const start = { lat: u.holdPoint.lat, lon: u.holdPoint.lon }
      this.personnel.push({
        uid: `WT-SIM-${u.spec.callsign}-M${i + 1}`,
        callsign: `${u.spec.callsign}/${i + 1}`,
        role,
        parentCallsign: u.spec.callsign,
        anchor,
        pos: start,
        target: anchor,
        walkSpeed: 1.1 + Math.random() * 0.5,
        pauseTicks: 0,
        startedAt: Date.now(),
        bio: freshBio(role),
        rotating: false,
      })
    }
  }

  /** Walk personnel between wander waypoints and evolve their vitals. */
  private tickPersonnel(): void {
    for (const p of this.personnel) {
      // movement: walk toward target, pause, pick a new waypoint near anchor
      const stepM = p.walkSpeed * (TICK_MS / 1000)
      const distToTarget = Math.hypot(
        (p.target.lat - p.pos.lat) * 111_320,
        (p.target.lon - p.pos.lon) * 111_320 * Math.cos((p.pos.lat * Math.PI) / 180),
      )
      let speed = 0
      let course = 0
      if (p.pauseTicks > 0) {
        p.pauseTicks--
      } else if (distToTarget > stepM) {
        course = bearingDeg(p.pos.lat, p.pos.lon, p.target.lat, p.target.lon)
        p.pos = destination(p.pos.lat, p.pos.lon, course, stepM)
        speed = p.walkSpeed
      } else {
        p.pos = { ...p.target }
        if (p.rotating) {
          // reached rehab — vitals recover slowly, member holds there
          p.bio.hr = Math.max(96, p.bio.hr - 4)
          p.bio.tempC = Math.max(37.0, p.bio.tempC - 0.05)
        } else {
          p.pauseTicks = 2 + Math.floor(Math.random() * 5)
          p.target = destination(p.anchor.lat, p.anchor.lon, Math.random() * 360, 4 + Math.random() * 28)
        }
      }

      // biometrics: working members trend up; SCBA burns down while working
      if (!p.rotating) {
        const exertion = p.role === 'ff' ? 1 : 0.55
        p.bio.toaMin += TICK_MS / 60000
        p.bio.hr = Math.min(196, p.bio.hr + (Math.random() * 3.2 - 0.7) * exertion + p.bio.toaMin * 0.045)
        p.bio.tempC = Math.min(39.6, p.bio.tempC + 0.006 * exertion + Math.random() * 0.004)
        if (p.bio.airPsi >= 0) p.bio.airPsi = Math.max(180, p.bio.airPsi - (26 + Math.random() * 22))
        if (bioStatus(p.bio) === 'rotate') {
          p.rotating = true
          const rig = this.units.find((u) => u.spec.callsign === p.parentCallsign)
          p.target = rig ? { ...rig.holdPoint } : { ...p.anchor }
          this.onEvent?.('sim.rotation', { callsign: p.callsign, reason: rotationReason(p.bio) })
          console.log(`[sim] ROTATE ${p.callsign} (${rotationReason(p.bio)})`)
        }
      }

      const status = p.rotating ? 'Rehab' : 'Operating'
      this.publish(
        buildCotXml({
          uid: p.uid,
          callsign: p.callsign,
          type: CATEGORY_COT_TYPE[p.role],
          lat: p.pos.lat,
          lon: p.pos.lon,
          hae: 0,
          course,
          speed,
          status,
          role: p.role,
          bio: p.bio,
          staleSeconds: 120,
        }),
      )
    }
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
    this.tickPersonnel()
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
          this.spawnCrew(u)
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

function rotationReason(bio: BioTelemetry): string {
  if (bio.airPsi >= 0 && bio.airPsi <= 1100) return 'SCBA low air'
  if (bio.hr >= 178) return 'sustained high heart rate'
  if (bio.tempC >= 38.5) return 'core temperature'
  return 'time on air'
}

/** Fresh member baseline vitals. */
function freshBio(role: PersonnelRole): BioTelemetry {
  return {
    hr: 88 + Math.random() * 14,
    airPsi: role === 'ff' ? 4400 + Math.random() * 100 : -1,
    tempC: 36.9 + Math.random() * 0.3,
    toaMin: 0,
  }
}

/** Rotation thresholds (decision-support; tuned for a readable demo arc). */
export function bioStatus(bio: BioTelemetry): 'ok' | 'caution' | 'rotate' {
  if (bio.hr >= 178 || (bio.airPsi >= 0 && bio.airPsi <= 1100) || bio.tempC >= 38.5 || bio.toaMin >= 22) {
    return 'rotate'
  }
  if (bio.hr >= 160 || (bio.airPsi >= 0 && bio.airPsi <= 1800) || bio.tempC >= 38.0 || bio.toaMin >= 16) {
    return 'caution'
  }
  return 'ok'
}
