import { clearLocalIncident, unitMapVisible } from './actions'
import { getShapeLayer, getUnitLayer } from './cesium/scene'
import { getAppState, setAppState } from './state/store'
import type { IcsShape, Incident, Unit } from './types'

// ---------------------------------------------------------------------------
// REPLAY (Phase 8): re-runs the incident timeline from incident.json at 4x.
// Unit motion comes from the compact `unit.track` samples the server records;
// shapes replay their create/edit/delete lifecycle. Scrubbing rebuilds state
// at the target time from scratch (event counts are small by design).
// ---------------------------------------------------------------------------

interface RawEvent {
  t: string
  kind: string
  payload?: unknown
}

interface ReplayEvent {
  tm: number
  kind: string
  payload: Record<string, unknown>
}

const SPEED = 4
const TICK_MS = 120

class ReplayEngine {
  private events: ReplayEvent[] = []
  private t0 = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private cursor = 0 // events applied so far (index into this.events)

  private starting = false

  async start(): Promise<void> {
    // Re-entrancy guard: replay.active only flips after the fetch resolves,
    // so a double-click would otherwise stack two tick intervals.
    if (this.starting || getAppState().replay.active) return
    this.starting = true
    try {
      await this.startInner()
    } finally {
      this.starting = false
    }
  }

  private async startInner(): Promise<void> {
    const res = await fetch('/api/incident')
    if (!res.ok) return
    const body = (await res.json()) as { timeline: RawEvent[] }
    const events = (body.timeline ?? [])
      .map((e) => ({ tm: Date.parse(e.t), kind: e.kind, payload: (e.payload ?? {}) as Record<string, unknown> }))
      .filter((e) => Number.isFinite(e.tm))
      .sort((a, b) => a.tm - b.tm)
    if (events.length < 2) {
      console.warn('[replay] not enough timeline to replay')
      return
    }
    this.events = events
    this.t0 = events[0].tm
    const duration = events[events.length - 1].tm - this.t0

    setAppState({ replay: { active: true, playing: true, t: 0, duration } })
    this.rebuildAt(0)
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    setAppState({ replay: { active: false, playing: false, t: 0, duration: 0 } })
    void this.resyncLive()
  }

  setPlaying(playing: boolean): void {
    setAppState((s) => ({ replay: { ...s.replay, playing } }))
  }

  seek(t: number): void {
    setAppState((s) => ({ replay: { ...s.replay, t } }))
    this.rebuildAt(t)
  }

  private tick(): void {
    const { replay } = getAppState()
    if (!replay.active || !replay.playing) return
    const t = Math.min(replay.t + TICK_MS * SPEED, replay.duration)
    setAppState((s) => ({ replay: { ...s.replay, t } }))
    this.applyRange(t)
    if (t >= replay.duration) this.setPlaying(false)
  }

  /** Apply events forward from the cursor up to time t (fast path while playing). */
  private applyRange(t: number): void {
    const cutoff = this.t0 + t
    while (this.cursor < this.events.length && this.events[this.cursor].tm <= cutoff) {
      this.applyEvent(this.events[this.cursor])
      this.cursor++
    }
  }

  /** Rebuild the whole picture at time t (used on start and scrubbing). */
  private rebuildAt(t: number): void {
    const cutoff = this.t0 + t
    getUnitLayer()?.clear()
    getShapeLayer()?.clear()
    const shapes = new Map<string, IcsShape>()
    const tracks = new Map<string, Record<string, unknown>>()
    for (const ev of this.events) {
      if (ev.tm > cutoff) break
      if (ev.kind === 'shape.upserted') shapes.set(String((ev.payload as { id?: string }).id), ev.payload as unknown as IcsShape)
      else if (ev.kind === 'shape.removed') shapes.delete(String((ev.payload as { id?: string }).id))
      else if (ev.kind === 'unit.track') tracks.set(String(ev.payload.uid), ev.payload)
    }
    for (const s of shapes.values()) getShapeLayer()?.upsert(s)
    for (const p of tracks.values()) {
      // Historical dots honor the SAME visibility policy as live ones — the
      // GPS master switch and the interior-FF-only member rule hold in replay.
      const u = trackToUnit(p)
      getUnitLayer()?.upsert(u, unitMapVisible(u))
    }
    this.cursor = this.events.findIndex((e) => e.tm > cutoff)
    if (this.cursor === -1) this.cursor = this.events.length
  }

  private applyEvent(ev: ReplayEvent): void {
    if (ev.kind === 'shape.upserted') getShapeLayer()?.upsert(ev.payload as unknown as IcsShape)
    else if (ev.kind === 'shape.removed') getShapeLayer()?.remove(String((ev.payload as { id?: string }).id))
    else if (ev.kind === 'unit.track') {
      const u = trackToUnit(ev.payload)
      getUnitLayer()?.upsert(u, unitMapVisible(u))
    }
  }

  /** Leaving replay: restore the live picture from the server. */
  private async resyncLive(): Promise<void> {
    getUnitLayer()?.clear()
    getShapeLayer()?.clear()
    try {
      const [incidentRes, unitsRes] = await Promise.all([fetch('/api/incident'), fetch('/api/units')])
      const incidentBody = (await incidentRes.json()) as {
        incident?: Incident | null
        shapes?: IcsShape[]
        timeline?: { t: string; kind: string; payload?: unknown }[]
      }
      const unitsBody = (await unitsRes.json()) as { units?: Unit[] }
      // Incident may have ENDED or changed while replay held the gate closed.
      const local = getAppState().incident
      if (!incidentBody.incident && local) {
        clearLocalIncident()
        return
      }
      const shapes: Record<string, IcsShape> = {}
      for (const s of incidentBody.shapes ?? []) {
        shapes[s.id] = s
        getShapeLayer()?.upsert(s)
      }
      const units: Record<string, Unit> = {}
      for (const u of unitsBody.units ?? []) {
        units[u.uid] = u
        // The ONE visibility policy — not raw category toggles. Bypassing it
        // here violated the GPS switch and the interior-FF-only member rule.
        getUnitLayer()?.upsert(u, unitMapVisible(u))
      }
      // Milestones that broadcast during replay were gated out — recover them.
      const timeline = (incidentBody.timeline ?? []).filter((e) => e.kind !== 'unit.track').slice(-400)
      setAppState({
        shapes,
        units,
        timeline,
        ...(incidentBody.incident ? { incident: incidentBody.incident } : {}),
      })
    } catch (err) {
      console.error('[replay] live resync failed:', err)
    }
  }
}

function trackToUnit(p: Record<string, unknown>): Unit {
  return {
    uid: String(p.uid),
    callsign: String(p.callsign ?? p.uid),
    category: (p.category as Unit['category']) ?? 'unknown',
    agency: (p.agency as Unit['agency']) ?? 'TAK',
    lat: Number(p.lat),
    lon: Number(p.lon),
    hae: Number(p.hae ?? 0),
    status: p.status as string | undefined,
    // Recorded per sample: interior members must replay ON their floor (and
    // the "· FL n" label / interior-FF visibility rule need it too).
    floor: typeof p.floor === 'number' ? p.floor : undefined,
    cotType: 'replay',
    updatedAt: new Date().toISOString(),
    staleAt: new Date(Date.now() + 600_000).toISOString(),
  }
}

export const replayEngine = new ReplayEngine()
