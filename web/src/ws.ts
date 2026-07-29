import { getShapeLayer, getUnitLayer } from './cesium/scene'
import { getAppState, setAppState } from './state/store'
import type { CommsChannel, IcsShape, Incident, TranscriptLine, Unit } from './types'

interface SnapshotMsg {
  type: 'snapshot'
  incident: Incident | null
  units?: Unit[]
  shapes?: IcsShape[]
  takConnected?: boolean
}
interface ShapeMsg {
  type: 'shape'
  shape: IcsShape
}
interface ShapeRemoveMsg {
  type: 'shape.remove'
  id: string
}
interface IncidentMsg {
  type: 'incident'
  incident: Incident | null
}
interface UnitMsg {
  type: 'unit'
  unit: Unit
}
interface UnitRemoveMsg {
  type: 'unit.remove'
  uid: string
}
interface TakStatusMsg {
  type: 'tak.status'
  connected: boolean
}
interface TimelineMsg {
  type: 'timeline'
  event: { t: string; kind: string; payload?: unknown }
}
interface TranscriptMsg {
  type: 'transcript'
  channel: CommsChannel
  line: TranscriptLine
}
type ServerMsg =
  | SnapshotMsg
  | IncidentMsg
  | UnitMsg
  | UnitRemoveMsg
  | TakStatusMsg
  | ShapeMsg
  | ShapeRemoveMsg
  | TimelineMsg
  | TranscriptMsg

let started = false

/** Live server link (unit picture, TAK status, incident sync). Reconnects forever. */
export function connectWs(): void {
  if (started) return
  started = true
  let retryMs = 1000

  const open = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws`)

    ws.onopen = () => {
      retryMs = 1000
    }
    ws.onmessage = (e) => {
      try {
        handle(JSON.parse(e.data as string) as ServerMsg)
      } catch (err) {
        console.error('[ws] bad message:', err)
      }
    }
    ws.onclose = () => {
      setAppState({ takConnected: null })
      setTimeout(open, retryMs)
      retryMs = Math.min(retryMs * 1.6, 10_000)
    }
  }
  open()
}

function handle(msg: ServerMsg): void {
  // During REPLAY the globe belongs to the replay engine — hold live mutations
  // (transcripts still flow; they're history-safe).
  if (getAppState().replay.active && msg.type !== 'transcript' && msg.type !== 'tak.status') return
  switch (msg.type) {
    case 'snapshot': {
      // Authoritative rebuild — clears units/shapes that changed while
      // disconnected (e.g. server restart swept the registry).
      getUnitLayer()?.clear()
      const units: Record<string, Unit> = {}
      for (const u of msg.units ?? []) {
        units[u.uid] = u
        getUnitLayer()?.upsert(u, getAppState().unitToggles[u.category] ?? true)
      }
      getShapeLayer()?.clear()
      const shapes: Record<string, IcsShape> = {}
      for (const s of msg.shapes ?? []) {
        shapes[s.id] = s
        getShapeLayer()?.upsert(s)
      }
      setAppState({ units, shapes, takConnected: msg.takConnected ?? null })
      break
    }
    case 'incident':
      setAppState({ incident: msg.incident })
      break
    case 'unit':
      setAppState((s) => ({ units: { ...s.units, [msg.unit.uid]: msg.unit } }))
      getUnitLayer()?.upsert(msg.unit, getAppState().unitToggles[msg.unit.category] ?? true)
      break
    case 'unit.remove':
      setAppState((s) => {
        const units = { ...s.units }
        delete units[msg.uid]
        return { units }
      })
      getUnitLayer()?.remove(msg.uid)
      break
    case 'tak.status':
      setAppState({ takConnected: msg.connected })
      break
    case 'shape':
      setAppState((s) => ({ shapes: { ...s.shapes, [msg.shape.id]: msg.shape } }))
      getShapeLayer()?.upsert(msg.shape)
      break
    case 'shape.remove':
      setAppState((s) => {
        const shapes = { ...s.shapes }
        delete shapes[msg.id]
        return { shapes }
      })
      getShapeLayer()?.remove(msg.id)
      break
    case 'timeline':
      break // consumed in Phase 8 (replay); nothing to do live yet
    case 'transcript': {
      const MAX_LINES = 200
      setAppState((s) => ({
        transcripts: {
          ...s.transcripts,
          [msg.channel]: [...s.transcripts[msg.channel], msg.line].slice(-MAX_LINES),
        },
      }))
      // FDNY designator mentions flash the matching roster unit on the globe.
      if (msg.channel === 'fdny') {
        const units = Object.values(getAppState().units)
        for (const kw of msg.line.keywords) {
          if (kw.kind !== 'unit' || !kw.callsign) continue
          const unit = units.find((u) => u.callsign.toUpperCase() === kw.callsign)
          if (unit) getUnitLayer()?.flash(unit.uid)
        }
      }
      break
    }
  }
}
