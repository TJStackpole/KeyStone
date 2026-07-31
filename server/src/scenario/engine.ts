import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractKeywords, type CommsChannel, type TranscriptLine } from '../comms.js'
import { DRILL_UID_PREFIX } from '../sim/ns.js'
import { buildCotXml, categorize, CATEGORY_COT_TYPE, type BioTelemetry } from '../tak/cot.js'
import { shapeToCot, shapeDeleteCot } from '../tak/shapes.js'
import type { IcsShape, Incident } from '../types.js'

// ---------------------------------------------------------------------------
// Scenario playback engine (Prompt 8A): plays a scripted incident through the
// SAME pipelines as live data — unit positions go out as genuine CoT via the
// simulator's TAK connection, radio traffic lands on the transcript bus,
// annotations flow through the shape store + CoT publisher. The dashboard
// cannot tell scenario traffic from a live feed; there are no demo-only
// rendering paths.
// ---------------------------------------------------------------------------

export interface ScenarioChapter {
  id: string
  t: number
  title: string
}

interface SpawnDef {
  uid?: string
  callsign: string
  role?: string
  lat: number
  lon: number
  hae?: number
  status?: string
  floor?: number
  bio?: BioTelemetry
}

/** Prompt 11: a scripted SECONDARY incident — a portfolio entry the Watch
 *  Command view tracks alongside the primary drill (counts + ticker, no CoT
 *  unit stream of its own). CIMS labels are explicit, never inferred. */
export interface SecondaryIncidentDef {
  id: string
  address: string
  borough: string
  lat: number
  lon: number
  type: string
  primaryAgency: string
  supportingAgencies?: string[]
  severity: number
  unitsByAgency?: Record<string, number>
}

export interface ScenarioEvent {
  t: number
  kind:
    | 'unit_spawn'
    | 'unit_move'
    | 'status_change'
    | 'radio_tx'
    | 'annotation'
    | 'annotation_remove'
    | 'alarm_level'
    | 'exposure'
    | 'timeline'
    | 'alert'
    | 'aar'
    // Prompt 11 (NYCEM coordination layer):
    | 'incident_spawn'
    | 'incident_update'
    | 'incident_close'
    | 'request'
    | 'request_transition'
    | 'nws_mock'
  unit?: SpawnDef
  callsign?: string
  path?: [number, number][]
  durationS?: number
  endStatus?: string
  status?: string
  floor?: number
  bio?: BioTelemetry
  channel?: CommsChannel
  from?: string
  text?: string
  shape?: IcsShape
  id?: string
  level?: Incident['alarmLevel']
  labels?: { text: string; lat: number; lon: number }[]
  event?: string
  payload?: Record<string, unknown>
  alert?: { kind: string; callsign?: string; text?: string }
  // Prompt 11 payloads:
  incident?: SecondaryIncidentDef
  incidentId?: string
  update?: { severity?: number; unitsByAgency?: Record<string, number>; note?: string }
  request?: {
    refId: string
    incidentId?: string | null // 'primary' targets the drill board
    requestingAgency: string
    assignedAgency: string
    description: string
    priority: 'routine' | 'urgent' | 'immediate'
    createdBy: string
  }
  refId?: string
  state?: string
  by?: string
  reason?: string
  nws?: {
    id: string
    event: string
    headline: string
    severity: string
    endsInMin?: number
    areaDesc: string
    polygons?: [number, number][][]
  }
}

interface ScenarioFile {
  name: string
  drill: boolean
  incident: { address: string; lat: number; lon: number; bin?: string; bbl?: string; type?: string }
  chapters: ScenarioChapter[]
  events: ScenarioEvent[]
}

interface ScenarioUnit {
  uid: string
  callsign: string
  role?: string
  lat: number
  lon: number
  hae: number
  status?: string
  floor?: number
  bio?: BioTelemetry
  move?: { path: [number, number][]; startT: number; durationS: number; totalM: number; endStatus?: string }
  lastTx: number
}

export interface EngineDeps {
  publishCot: (xml: string) => boolean
  broadcast: (msg: unknown) => void
  emitTimeline: (kind: string, payload: Record<string, unknown>) => void
  createIncident: (incident: Incident) => void
  upsertShape: (shape: IcsShape) => void
  removeShape: (id: string) => boolean
  /** `tombstone: false` on rewinds — the unit respawns in the same ms and a
   *  tombstone would swallow the respawn's TAK echo (empty drill board). */
  removeUnit: (uid: string, opts?: { tombstone?: boolean }) => void
  setAlarm: (level: Incident['alarmLevel']) => void
  // Prompt 11 — NYCEM coordination layer hooks (all optional so older
  // single-incident scenarios keep running untouched):
  portfolioChanged?: () => void
  openRequest?: (req: NonNullable<ScenarioEvent['request']>, incidentId: string | null) => string | null
  transitionRequest?: (id: string, state: string, by: string, reason?: string) => void
  injectNws?: (nws: NonNullable<ScenarioEvent['nws']>) => void
}

const SCENARIO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../assets/scenarios')

/** The drill-only comms channels — reset on load/stop/rewind so a previous
 * run's (or pre-rewind future) radio traffic can't linger in the panel. */
const SCENARIO_CHANNELS = ['fdny-tac', 'fdny-cmd', 'ems-cw', 'nypd-sod', 'papd', 'interagency']

const TICK_MS = 500
const MOVE_TX_INTERVAL_S = 2 // scenario seconds between CoT for a moving unit
const IDLE_TX_INTERVAL_S = 20

/**
 * Re-home a drill uid/shape id onto THIS stack's namespace (DRILL-<ns>-…).
 * Scenario JSON ships fixed uids and ids, so two parallel dev stacks playing
 * the same drill through the shared TAK server would publish IDENTICAL uids —
 * cross-feeding each other's unit registries and deleting each other's shapes
 * on real ATAK phones (see sim/ns.ts). Idempotent; a bare DRILL- prefix is
 * stripped first so legacy ids don't double the family marker.
 */
function drillId(raw: string): string {
  if (raw.startsWith(DRILL_UID_PREFIX)) return raw
  return DRILL_UID_PREFIX + (raw.startsWith('DRILL-') ? raw.slice('DRILL-'.length) : raw)
}

function segLengths(path: [number, number][]): { cum: number[]; total: number } {
  const R = 6371008.8
  const cum = [0]
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const [lon1, lat1] = path[i - 1]
    const [lon2, lat2] = path[i]
    const dLat = ((lat2 - lat1) * Math.PI) / 180
    const dLon = (((lon2 - lon1) * Math.PI) / 180) * Math.cos((lat1 * Math.PI) / 180)
    total += Math.sqrt(dLat * dLat + dLon * dLon) * R
    cum.push(total)
  }
  return { cum, total }
}

function bearing(from: [number, number], to: [number, number]): number {
  const dLon = to[0] - from[0]
  const dLat = to[1] - from[1]
  return (Math.atan2(dLon * Math.cos((from[1] * Math.PI) / 180), dLat) * 180) / Math.PI
}

export class ScenarioEngine extends EventEmitter {
  private file: ScenarioFile | null = null
  private clock = 0
  private playing = false
  private speed = 4
  private cursor = 0 // next unprocessed event index
  private units = new Map<string, ScenarioUnit>() // keyed by callsign
  private shapeIds = new Set<string>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastStatusPush = 0
  private pendingAlert: Record<string, unknown> | null = null
  private lastKeepalive = 0
  /** High-water event INDEX whose milestones were already emitted — events
   *  replayed below it (after a rewind) must not re-append to the timeline. */
  private maxEmittedCursor = 0

  // Prompt 11 — coordination-layer state carried by the scenario:
  /** Scripted SECONDARY incidents (portfolio entries beside the drill board). */
  private secondary = new Map<string, SecondaryIncidentDef & { startedAt: string; closed?: boolean }>()
  /** Scenario request refIds -> real request-store ids. */
  private requestIds = new Map<string, string>()
  /** Exercise mode: participants interact live while the script drives. */
  exercise = false
  exerciseStartedAt: string | null = null

  constructor(private deps: EngineDeps) {
    super()
  }

  get loaded(): boolean {
    return this.file !== null
  }

  /** Watch Command portfolio: the scripted secondary incidents still open. */
  secondaryIncidents(): (SecondaryIncidentDef & { startedAt: string })[] {
    return [...this.secondary.values()].filter((s) => !s.closed)
  }

  status(): Record<string, unknown> {
    return {
      loaded: this.loaded,
      name: this.file?.name ?? null,
      drill: this.file?.drill ?? false,
      playing: this.playing,
      speed: this.speed,
      clock: Math.round(this.clock),
      duration: this.file ? Math.max(...this.file.events.map((e) => e.t)) : 0,
      chapters: this.file?.chapters ?? [],
      exercise: this.exercise,
    }
  }

  /** Exercise mode flag (M8): set at load; recorded into the session AAR. */
  setExercise(on: boolean): void {
    this.exercise = on
    this.exerciseStartedAt = on ? new Date().toISOString() : null
  }

  async load(name: string): Promise<void> {
    const safe = name.replace(/[^a-z0-9-]/gi, '')
    const raw = await readFile(resolve(SCENARIO_DIR, `${safe}.json`), 'utf8')
    const file = JSON.parse(raw) as ScenarioFile
    file.events.sort((a, b) => a.t - b.t)
    // Normalize every drill uid/id onto this stack's DRILL-<ns>- namespace.
    // The DRILL- family keys tombstones, the rx-log filter, SIM chat badging,
    // and arrival chatter — an unprefixed uid would silently lose every one
    // of those behaviors. The <ns> isolates parallel dev stacks playing the
    // same scenario file; without it our OWN ingest filter (units.ts) would
    // even drop our own units' TAK echo as foreign and the board stays empty.
    for (const ev of file.events) {
      if (ev.kind === 'unit_spawn' && ev.unit) {
        ev.unit.uid = drillId(ev.unit.uid ?? ev.unit.callsign)
      } else if (ev.kind === 'annotation' && ev.shape?.id) {
        ev.shape.id = drillId(ev.shape.id)
      } else if (ev.kind === 'annotation_remove' && ev.id) {
        ev.id = drillId(ev.id)
      }
    }
    this.teardown()
    this.file = file
    const inc: Incident = {
      id: `DRILL-${Date.now().toString(36).toUpperCase()}`,
      address: file.incident.address,
      lat: file.incident.lat,
      lon: file.incident.lon,
      bin: file.incident.bin,
      bbl: file.incident.bbl,
      type: (file.incident.type ?? 'Structural Fire') as Incident['type'],
      createdAt: new Date().toISOString(),
      alarmLevel: '10-75',
    } as Incident
    this.deps.createIncident(inc)
    this.resetTranscripts() // a previous run's radio log is stale, not history
    this.deps.emitTimeline('scenario.loaded', { name: file.name, drill: file.drill })
    this.pushStatus()
  }

  /** Tell every dashboard to clear the drill-only comms channels. */
  private resetTranscripts(): void {
    this.deps.broadcast({ type: 'transcript.reset', channels: SCENARIO_CHANNELS })
  }

  private ensureTimer(): void {
    // The tick's paused branch is the keepalive that stops the stale sweep
    // from emptying a seeked-but-never-played drill board.
    if (!this.timer && this.file) {
      this.timer = setInterval(() => this.tick(), TICK_MS)
      this.timer.unref()
    }
  }

  play(): void {
    if (!this.file) return
    this.playing = true
    this.ensureTimer()
    this.pushStatus()
  }

  pause(): void {
    this.playing = false
    this.pushStatus()
  }

  setSpeed(x: number): void {
    if ([1, 4, 10].includes(x)) this.speed = x
    this.pushStatus()
  }

  /** Jump to a chapter. Backward jumps replay the scenario from T0 silently. */
  async seekChapter(id: string): Promise<void> {
    const ch = this.file?.chapters.find((c) => c.id === id)
    if (!ch) return
    this.seekTo(ch.t, ch.title)
  }

  /** Seek to an arbitrary scenario second (progress-bar scrubbing). */
  seekTo(t: number, label?: string): void {
    if (!this.file) return
    const duration = Math.max(...this.file.events.map((e) => e.t))
    const target = Math.max(0, Math.min(t, duration))
    const rewind = target < this.clock
    // Scrub direction must not change transport state — teardown(true)
    // forces playing=false, so remember and restore it.
    const wasPlaying = this.playing
    if (rewind) {
      const name = this.file.name
      const fileRef = this.file
      // Units catchUp is about to respawn re-announce in the SAME millisecond
      // — their removals must skip the echo tombstone. Units whose spawn lies
      // AFTER the target get NO respawn, so they keep the tombstone or their
      // in-flight echoes resurrect them as 10-minute ghosts.
      const respawning = new Set(
        this.file.events
          .filter((e) => e.kind === 'unit_spawn' && e.t <= target && e.unit)
          .map((e) => e.unit!.uid ?? drillId(e.unit!.callsign)),
      )
      this.teardown(true, respawning)
      this.file = fileRef
      // The dashboards already hold everything up to the old clock — clear the
      // drill channels so the silent replay rebuilds them without duplicates.
      this.resetTranscripts()
      this.deps.emitTimeline('scenario.rewind', { name, to: label ?? `T+${Math.round(target)}s` })
    }
    this.catchUp(target, rewind)
    this.playing = wasPlaying
    // catchUp just transmitted every unit; start the keepalive clock from now
    // and make sure the tick timer exists even if play was never pressed.
    this.lastKeepalive = Date.now()
    this.ensureTimer()
    this.pushStatus()
  }

  stop(): void {
    this.teardown()
    this.resetTranscripts()
    this.pushStatus()
  }

  /** Remove everything the scenario put on the picture. */
  private teardown(keepIncident = false, respawning?: Set<string>): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    // Rewind: only units the seek is about to respawn skip the tombstone.
    for (const u of this.units.values()) {
      this.deps.removeUnit(u.uid, { tombstone: !(keepIncident && respawning?.has(u.uid)) })
    }
    for (const id of this.shapeIds) {
      if (this.deps.removeShape(id)) {
        this.deps.broadcast({ type: 'shape.remove', id })
        this.deps.publishCot(shapeDeleteCot(id))
      }
    }
    this.units.clear()
    this.shapeIds.clear()
    this.deps.broadcast({ type: 'exposure', labels: [] })
    this.deps.broadcast({ type: 'alert', alert: { kind: 'clear' } })
    this.clock = 0
    this.cursor = 0
    this.playing = false
    // Prompt 11: scripted secondary incidents leave the portfolio with the
    // scenario (rewinds respawn them via catchUp). Requests persist — they
    // are the accountability record the AAR slices by session window.
    if (this.secondary.size) {
      this.secondary.clear()
      this.requestIds.clear()
      this.deps.portfolioChanged?.()
    }
    if (!keepIncident) {
      this.file = null
      this.maxEmittedCursor = 0 // rewinds keep it — that's its whole purpose
      this.exercise = false
      this.exerciseStartedAt = null
    }
  }

  private tick(): void {
    if (!this.file) return
    if (!this.playing) {
      // Paused drills still keep their units alive — CoT staleness would
      // otherwise sweep the whole board after ~10 minutes of pause.
      if (Date.now() - this.lastKeepalive > 60_000) {
        this.lastKeepalive = Date.now()
        for (const u of this.units.values()) this.txUnit(u)
      }
      return
    }
    this.clock += (TICK_MS / 1000) * this.speed
    this.processDue(false)
    this.moveUnits()
    if (Date.now() - this.lastStatusPush > 1000) this.pushStatus()
    const duration = Math.max(...this.file.events.map((e) => e.t))
    if (this.clock > duration + 10) this.pause()
  }

  /**
   * Fast-forward to `t`, applying every due event instantly. `rewind` marks a
   * silent replay after a backward seek: every replayed event was ALREADY
   * recorded on the live pass, so timeline milestones are suppressed (radio
   * lines still broadcast — the rewind cleared the drill channels first).
   */
  private catchUp(t: number, rewind = false): void {
    this.clock = t
    this.pendingAlert = null
    this.processDue(true, rewind)
    this.moveUnits()
    // Net alert state after the seek: an unresolved mayday shows, a resolved
    // (or absent) one clears whatever overlay was up before the jump.
    // (processDue mutates pendingAlert — TS control flow can't see that.)
    const net = this.pendingAlert as Record<string, unknown> | null
    this.deps.broadcast({
      type: 'alert',
      alert: net && net.kind !== 'clear' ? net : { kind: 'clear' },
    })
  }

  private processDue(catchUp: boolean, rewind = false): void {
    if (!this.file) return
    while (this.cursor < this.file.events.length && this.file.events[this.cursor].t <= this.clock) {
      const idx = this.cursor
      const ev = this.file.events[this.cursor++]
      // "Replayed" = this exact event already emitted its milestone on an
      // earlier pass (we rewound below it). Covers both the silent catch-up
      // AND live playback re-crossing the (target, old-clock] span.
      const replayed = idx < this.maxEmittedCursor
      try {
        this.apply(ev, catchUp, rewind, replayed)
      } catch (err) {
        console.error('[scenario] event failed:', ev.kind, err)
      }
      if (!replayed) this.maxEmittedCursor = idx + 1
    }
  }

  private apply(ev: ScenarioEvent, catchUp: boolean, rewind = false, replayed = false): void {
    // A rewound/replayed event is by construction already in the persisted
    // timeline — re-emitting would duplicate SITREP milestones.
    const emitTimeline = rewind || replayed ? () => undefined : this.deps.emitTimeline
    switch (ev.kind) {
      case 'unit_spawn': {
        const d = ev.unit!
        const uid = d.uid ?? drillId(d.callsign)
        const u: ScenarioUnit = {
          uid,
          callsign: d.callsign,
          role: d.role,
          lat: d.lat,
          lon: d.lon,
          hae: d.hae ?? 0,
          status: d.status ?? 'Enroute',
          floor: d.floor,
          bio: d.bio,
          lastTx: -999,
        }
        this.units.set(d.callsign, u)
        this.txUnit(u)
        break
      }
      case 'unit_move': {
        const u = this.units.get(ev.callsign!)
        if (!u || !ev.path?.length) break
        const path: [number, number][] = [[u.lon, u.lat], ...ev.path]
        const { total } = segLengths(path)
        u.move = { path, startT: ev.t, durationS: ev.durationS ?? 60, totalM: total, endStatus: ev.endStatus }
        break
      }
      case 'status_change': {
        const u = this.units.get(ev.callsign!)
        if (!u) break
        if (ev.status !== undefined) u.status = ev.status
        if (ev.floor !== undefined) u.floor = ev.floor
        if (ev.bio !== undefined) u.bio = ev.bio
        this.txUnit(u)
        emitTimeline('unit.status', { callsign: u.callsign, status: u.status, drill: true })
        break
      }
      case 'radio_tx': {
        const text = ev.from ? `${ev.from}: ${ev.text}` : (ev.text ?? '')
        const line: TranscriptLine = {
          id: `rtx-${randomUUID()}`,
          ts: new Date().toISOString(),
          text,
          keywords: extractKeywords(text),
          live: false,
        }
        this.deps.broadcast({ type: 'transcript', channel: ev.channel ?? 'interagency', line })
        break
      }
      case 'annotation': {
        const shape = { ...ev.shape! }
        if (!shape.id) shape.id = drillId(`SHAPE-${this.shapeIds.size + 1}`)
        shape.createdAt = new Date().toISOString()
        this.shapeIds.add(shape.id)
        this.deps.upsertShape(shape)
        this.deps.broadcast({ type: 'shape', shape })
        this.deps.publishCot(shapeToCot(shape))
        break
      }
      case 'annotation_remove': {
        if (ev.id && this.deps.removeShape(ev.id)) {
          this.shapeIds.delete(ev.id)
          this.deps.broadcast({ type: 'shape.remove', id: ev.id })
          this.deps.publishCot(shapeDeleteCot(ev.id))
        }
        break
      }
      case 'alarm_level': {
        this.deps.setAlarm(ev.level!)
        emitTimeline('alarm', { level: ev.level, drill: true })
        break
      }
      case 'exposure': {
        this.deps.broadcast({ type: 'exposure', labels: ev.labels ?? [] })
        emitTimeline('exposures.set', { count: ev.labels?.length ?? 0 })
        break
      }
      case 'timeline': {
        emitTimeline(ev.event ?? 'scenario.note', { ...(ev.payload ?? {}), drill: true })
        break
      }
      case 'alert': {
        const alert = { ...ev.alert!, at: new Date().toISOString() }
        const u = ev.alert?.callsign ? this.units.get(ev.alert.callsign) : undefined
        this.pendingAlert = { ...alert, uid: u?.uid, lat: u?.lat, lon: u?.lon }
        // During a chapter seek, only the FINAL alert state matters — firing
        // every historical mayday live would strobe the full-screen overlay.
        if (!catchUp) this.deps.broadcast({ type: 'alert', alert: this.pendingAlert })
        emitTimeline(`alert.${ev.alert!.kind}`, { callsign: ev.alert?.callsign, text: ev.alert?.text })
        break
      }
      case 'aar': {
        // Panel-open is EPHEMERAL UI: fire on every live crossing (a re-run
        // to the end should re-open the report) but never during the silent
        // seek replay. The timeline milestone follows the shared suppression
        // so a rewound re-crossing can't log it twice.
        if (!catchUp) this.deps.broadcast({ type: 'scenario.aar' })
        emitTimeline('scenario.aar', { name: this.file?.name ?? '' })
        break
      }
      // ------------------- Prompt 11: coordination layer -------------------
      case 'incident_spawn': {
        const def = ev.incident!
        this.secondary.set(def.id, { ...def, startedAt: new Date().toISOString() })
        emitTimeline('portfolio.incident', { id: def.id, address: def.address, primaryAgency: def.primaryAgency })
        this.deps.portfolioChanged?.()
        break
      }
      case 'incident_update': {
        const s = ev.incidentId ? this.secondary.get(ev.incidentId) : undefined
        if (!s || !ev.update) break
        if (ev.update.severity !== undefined) s.severity = ev.update.severity
        if (ev.update.unitsByAgency) s.unitsByAgency = ev.update.unitsByAgency
        if (ev.update.note) emitTimeline('portfolio.update', { id: s.id, note: ev.update.note })
        this.deps.portfolioChanged?.()
        break
      }
      case 'incident_close': {
        const s = ev.incidentId ? this.secondary.get(ev.incidentId) : undefined
        if (!s) break
        s.closed = true
        emitTimeline('portfolio.closed', { id: s.id, address: s.address })
        this.deps.portfolioChanged?.()
        break
      }
      case 'request': {
        const r = ev.request!
        // Replays/rewinds must not double-open scripted requests.
        if (this.requestIds.has(r.refId)) break
        const incidentId = r.incidentId === 'primary' ? '__PRIMARY__' : (r.incidentId ?? null)
        const realId = this.deps.openRequest?.(r, incidentId)
        if (realId) this.requestIds.set(r.refId, realId)
        break
      }
      case 'request_transition': {
        const realId = ev.refId ? this.requestIds.get(ev.refId) : undefined
        if (realId && ev.state) this.deps.transitionRequest?.(realId, ev.state, ev.by ?? 'scenario', ev.reason)
        break
      }
      case 'nws_mock': {
        // Synthetic product through the REAL trigger-evaluation path; fires
        // once (the weather engine dedupes by rule|product id on replays).
        if (ev.nws) this.deps.injectNws?.(ev.nws)
        break
      }
    }
  }

  private moveUnits(): void {
    for (const u of this.units.values()) {
      if (u.move) {
        const m = u.move
        const frac = Math.min(1, (this.clock - m.startT) / m.durationS)
        const { cum, total } = segLengths(m.path)
        const dist = frac * total
        let i = 1
        while (i < cum.length - 1 && cum[i] < dist) i++
        const segFrac = (dist - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1])
        const [lon1, lat1] = m.path[i - 1]
        const [lon2, lat2] = m.path[i]
        u.lon = lon1 + (lon2 - lon1) * segFrac
        u.lat = lat1 + (lat2 - lat1) * segFrac
        const course = (bearing([lon1, lat1], [lon2, lat2]) + 360) % 360
        if (frac >= 1) {
          if (m.endStatus) u.status = m.endStatus
          u.move = undefined
          this.txUnit(u)
        } else if (this.clock - u.lastTx >= MOVE_TX_INTERVAL_S) {
          this.txUnit(u, course, m.totalM / m.durationS)
        }
      } else if (this.clock - u.lastTx >= IDLE_TX_INTERVAL_S) {
        this.txUnit(u)
      }
    }
  }

  private txUnit(u: ScenarioUnit, course?: number, speed?: number): void {
    const category = categorize(u.callsign, '', u.role)
    this.deps.publishCot(
      buildCotXml({
        uid: u.uid,
        callsign: u.callsign,
        type: CATEGORY_COT_TYPE[category],
        lat: u.lat,
        lon: u.lon,
        hae: u.hae,
        course,
        speed,
        status: u.status,
        role: u.role,
        floor: u.floor,
        bio: u.bio,
        staleSeconds: 600,
      }),
    )
    u.lastTx = this.clock
  }

  private pushStatus(): void {
    this.lastStatusPush = Date.now()
    this.deps.broadcast({ type: 'scenario.status', scenario: this.status() })
  }
}
