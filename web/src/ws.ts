import { adoptIncident, flyToUnit } from './actions'
import { getExposureLayer, getShapeLayer, getUnitLayer } from './cesium/scene'
import { getAppState, setAppState } from './state/store'
import type {
  CommsChannel,
  ExposureLabel,
  IcsShape,
  Incident,
  MapAlert,
  ScenarioStatus,
  TimelineEvent,
  TranscriptLine,
  Unit,
} from './types'

interface SnapshotMsg {
  type: 'snapshot'
  incident: Incident | null
  units?: Unit[]
  shapes?: IcsShape[]
  timeline?: TimelineEvent[]
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
  event: TimelineEvent
}
interface TranscriptMsg {
  type: 'transcript'
  channel: CommsChannel
  line: TranscriptLine
}
interface ScenarioStatusMsg {
  type: 'scenario.status'
  scenario: ScenarioStatus
}
interface AlertMsg {
  type: 'alert'
  alert: MapAlert
}
interface ExposureMsg {
  type: 'exposure'
  labels: ExposureLabel[]
}
interface AarMsg {
  type: 'scenario.aar'
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
  | ScenarioStatusMsg
  | AlertMsg
  | ExposureMsg
  | AarMsg

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
      setAppState({
        units,
        shapes,
        timeline: (msg.timeline ?? []).slice(-600),
        takConnected: msg.takConnected ?? null,
      })
      break
    }
    case 'incident': {
      const prev = getAppState().incident
      if (msg.incident && msg.incident.id !== prev?.id) {
        // Server-initiated incident (scenario load) — full local stand-up.
        adoptIncident(msg.incident)
      } else {
        setAppState({ incident: msg.incident })
      }
      break
    }
    case 'unit': {
      setAppState((s) => ({ units: { ...s.units, [msg.unit.uid]: msg.unit } }))
      const st = getAppState()
      const show =
        (st.unitToggles[msg.unit.category] ?? true) && (st.agencyToggles[msg.unit.agency] ?? true)
      getUnitLayer()?.upsert(msg.unit, show)
      break
    }
    case 'scenario.status':
      setAppState({ scenario: msg.scenario.loaded ? msg.scenario : null })
      break
    case 'alert': {
      if (msg.alert.kind === 'clear') {
        setAppState({ alert: null })
      } else {
        setAppState({ alert: msg.alert })
        // Map snaps to the member in trouble; label revealed and pulsing.
        if (msg.alert.uid) flyToUnit(msg.alert.uid)
      }
      break
    }
    case 'exposure':
      getExposureLayer()?.set(msg.labels ?? [])
      break
    case 'scenario.aar':
      setAppState({ aarOpen: true })
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
      // unit.track samples exist for replay (read via REST) — storing them here
      // would flood the 600-event window and evict SITREP's milestones.
      if (msg.event.kind !== 'unit.track') {
        setAppState((s) => ({ timeline: [...s.timeline, msg.event].slice(-600) }))
      }
      break
    case 'transcript': {
      const MAX_LINES = 200
      setAppState((s) => {
        const existing = s.transcripts[msg.channel]
        const last = existing[existing.length - 1]
        // Identical ts+text can only be transport duplication (e.g. a stacked
        // dev-reload socket) — a real repeat transmission gets a fresh stamp.
        if (last && last.ts === msg.line.ts && last.text === msg.line.text) return {}
        return {
          transcripts: {
            ...s.transcripts,
            [msg.channel]: [...existing, msg.line].slice(-MAX_LINES),
          },
        }
      })
      // FDNY designator mentions flash the matching roster unit on the globe.
      if (msg.channel === 'fdny') {
        const units = Object.values(getAppState().units)
        for (const kw of msg.line.keywords) {
          if (kw.kind !== 'unit' || !kw.callsign) continue
          const unit = units.find((u) => u.callsign.toUpperCase() === kw.callsign)
          if (unit) {
            // reveal the label so the flash is identifiable, then pulse it
            getUnitLayer()?.showLabel(unit.uid)
            getUnitLayer()?.flash(unit.uid)
          }
        }
      }
      break
    }
  }
}
