import { getUnitLayer } from './cesium/scene'
import { getAppState, setAppState } from './state/store'
import type { Incident, Unit } from './types'

interface SnapshotMsg {
  type: 'snapshot'
  incident: Incident | null
  units?: Unit[]
  takConnected?: boolean
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
type ServerMsg = SnapshotMsg | IncidentMsg | UnitMsg | UnitRemoveMsg | TakStatusMsg

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
  switch (msg.type) {
    case 'snapshot': {
      // Authoritative rebuild — clears units that vanished while disconnected
      // (e.g. server restart swept the registry).
      getUnitLayer()?.clear()
      const units: Record<string, Unit> = {}
      for (const u of msg.units ?? []) {
        units[u.uid] = u
        getUnitLayer()?.upsert(u, getAppState().unitToggles[u.category] ?? true)
      }
      setAppState({ units, takConnected: msg.takConnected ?? null })
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
  }
}
