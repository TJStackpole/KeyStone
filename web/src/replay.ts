import { getShapeLayer, getUnitLayer } from './cesium/scene'
import { getAppState, setAppState } from './state/store'
import type { IcsShape, Unit } from './types'

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

  async start(): Promise<void> {
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
    for (const p of tracks.values()) getUnitLayer()?.upsert(trackToUnit(p))
    this.cursor = this.events.findIndex((e) => e.tm > cutoff)
    if (this.cursor === -1) this.cursor = this.events.length
  }

  private applyEvent(ev: ReplayEvent): void {
    if (ev.kind === 'shape.upserted') getShapeLayer()?.upsert(ev.payload as unknown as IcsShape)
    else if (ev.kind === 'shape.removed') getShapeLayer()?.remove(String((ev.payload as { id?: string }).id))
    else if (ev.kind === 'unit.track') getUnitLayer()?.upsert(trackToUnit(ev.payload))
  }

  /** Leaving replay: restore the live picture from the server. */
  private async resyncLive(): Promise<void> {
    getUnitLayer()?.clear()
    getShapeLayer()?.clear()
    try {
      const [incidentRes, unitsRes] = await Promise.all([fetch('/api/incident'), fetch('/api/units')])
      const incidentBody = (await incidentRes.json()) as { shapes?: IcsShape[] }
      const unitsBody = (await unitsRes.json()) as { units?: Unit[] }
      const shapes: Record<string, IcsShape> = {}
      for (const s of incidentBody.shapes ?? []) {
        shapes[s.id] = s
        getShapeLayer()?.upsert(s)
      }
      const units: Record<string, Unit> = {}
      for (const u of unitsBody.units ?? []) {
        units[u.uid] = u
        getUnitLayer()?.upsert(u, getAppState().unitToggles[u.category] ?? true)
      }
      setAppState({ shapes, units })
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
    cotType: 'replay',
    updatedAt: new Date().toISOString(),
    staleAt: new Date(Date.now() + 600_000).toISOString(),
  }
}

export const replayEngine = new ReplayEngine()
