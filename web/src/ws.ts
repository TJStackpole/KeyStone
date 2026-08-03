import { adoptIncident, applyUnitVisibility, clearLocalIncident, flyToAlert, relocateIncidentSite, unitMapVisible } from './actions'
import { getExposureLayer, getShapeLayer, getUnitLayer } from './cesium/scene'
import { getAppState, setAppState } from './state/store'
import type {
  ChatMsg,
  CommsChannel,
  EocChange,
  EocLevel,
  ExposureLabel,
  FeedIncident,
  IcsShape,
  Incident,
  InteragencyRequest,
  MapAlert,
  NwsAlert,
  PlanActivation,
  PortfolioIncident,
  RequestPriority,
  ScenarioStatus,
  TickerEvent,
  TimelineEvent,
  TranscriptLine,
  TriggerRule,
  TriggerSuggestion,
  FeedDataWire,
  FeedHealthWire,
  Unit,
  WeatherObsNycem,
} from './types'

interface SnapshotMsg {
  type: 'snapshot'
  incident: Incident | null
  units?: Unit[]
  shapes?: IcsShape[]
  timeline?: TimelineEvent[]
  takConnected?: boolean
  chats?: ChatMsg[]
  scenario?: ScenarioStatus
  dispatchFeed?: FeedIncident[]
  portfolio?: PortfolioIncident[]
  ticker?: TickerEvent[]
  eoc?: { level: EocLevel; history: EocChange[] }
  plans?: PlanActivation[]
  requests?: InteragencyRequest[]
  requestThresholds?: Record<RequestPriority, number>
  weather?: { alerts: NwsAlert[]; obs: WeatherObsNycem | null; suggestions: TriggerSuggestion[] }
  rules?: TriggerRule[]
  visibilityPolicy?: Record<string, string>
  feeds?: { health: FeedHealthWire[]; data: FeedDataWire[] }
}
interface FeedHealthMsg {
  type: 'feed.health'
  health: FeedHealthWire
}
interface FeedDataMsg {
  type: 'feed.data'
  data: FeedDataWire
}
interface PolicyMsg {
  type: 'policy'
  policy: Record<string, string>
}
interface DispatchFeedMsg {
  type: 'dispatch.feed'
  incidents: FeedIncident[]
}
interface PortfolioMsg {
  type: 'portfolio'
  incidents: PortfolioIncident[]
}
interface TickerMsg {
  type: 'ticker'
  event: TickerEvent
}
interface EocMsg {
  type: 'eoc'
  level: EocLevel
  history: EocChange[]
}
interface PlansMsg {
  type: 'plans'
  plans: PlanActivation[]
}
interface RequestsMsg {
  type: 'requests'
  requests: InteragencyRequest[]
}
interface WeatherMsg {
  type: 'weather'
  alerts: NwsAlert[]
  obs: WeatherObsNycem | null
  suggestions: TriggerSuggestion[]
}
interface RulesMsg {
  type: 'rules'
  rules: TriggerRule[]
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
interface UnitsBatchMsg {
  type: 'units.batch'
  units: Unit[]
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
interface TranscriptResetMsg {
  type: 'transcript.reset'
  channels: CommsChannel[]
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
interface ChatWsMsg {
  type: 'chat'
  msg: ChatMsg
}
type ServerMsg =
  | SnapshotMsg
  | PolicyMsg
  | IncidentMsg
  | UnitMsg
  | UnitsBatchMsg
  | UnitRemoveMsg
  | TakStatusMsg
  | ShapeMsg
  | ShapeRemoveMsg
  | TimelineMsg
  | TranscriptMsg
  | TranscriptResetMsg
  | ScenarioStatusMsg
  | AlertMsg
  | ExposureMsg
  | AarMsg
  | ChatWsMsg
  | DispatchFeedMsg
  | PortfolioMsg
  | TickerMsg
  | EocMsg
  | PlansMsg
  | RequestsMsg
  | WeatherMsg
  | FeedHealthMsg
  | FeedDataMsg
  | RulesMsg

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

// Message types that must flow even while REPLAY owns the globe: history-safe
// streams (transcript/chat/tak.status), live emergencies (alert), drill state
// (scenario.status), incident lifecycle, and the reconnect snapshot (handled
// replay-aware below).
const REPLAY_SAFE = new Set([
  'transcript',
  'transcript.reset',
  'tak.status',
  'incident',
  'alert',
  'scenario.status',
  'chat',
  'snapshot',
  'dispatch.feed', // ambient citywide picture — not part of the replayed board
  // Prompt 11 coordination layer sits ABOVE incidents — replay never gates it.
  'portfolio',
  'ticker',
  'eoc',
  'plans',
  'requests',
  'weather',
  'rules',
  'policy',
])

function handle(msg: ServerMsg): void {
  if (getAppState().replay.active && !REPLAY_SAFE.has(msg.type)) return
  switch (msg.type) {
    case 'snapshot': {
      // Reconcile the incident FIRST — a station that was disconnected when
      // END or a new stand-up happened only learns about it here. Same-id
      // snapshots still refresh mutable fields (alarm level, type).
      const local = getAppState().incident
      if (!msg.incident && local) clearLocalIncident()
      else if (msg.incident && msg.incident.id !== local?.id) adoptIncident(msg.incident)
      else if (msg.incident) {
        // Same-id snapshot can still carry a RELOCATION (live address
        // correction while this station was disconnected) — the coords never
        // repeat in a later message, so reconcile the site picture here too.
        const moved = local && (msg.incident.lat !== local.lat || msg.incident.lon !== local.lon)
        setAppState({ incident: msg.incident })
        if (moved) relocateIncidentSite(msg.incident)
      }
      // Drill transport state rides the snapshot too (server restarts). A
      // station that missed the drill's end must also drop the merged comms
      // view and any scenario-only channel whose tab no longer exists. Chats
      // ride along here too — ABOVE the replay gate: the chat panel is a
      // history-safe stream that stays live during replay, so a reconnect
      // backfill must not be dropped on the floor mid-replay.
      const scenarioLoaded = !!msg.scenario?.loaded
      setAppState((s) => ({
        scenario: scenarioLoaded ? (msg.scenario ?? null) : null,
        dispatchFeed: msg.dispatchFeed ?? s.dispatchFeed,
        // Prompt 11 coordination-layer state rides the snapshot too.
        portfolio: msg.portfolio ?? s.portfolio,
        tickerFeed: msg.ticker ?? s.tickerFeed,
        eoc: msg.eoc ?? s.eoc,
        planActivations: msg.plans ?? s.planActivations,
        interagencyRequests: msg.requests ?? s.interagencyRequests,
        requestThresholds: msg.requestThresholds ?? s.requestThresholds,
        // The rules editor is snapshot-fed: nothing else delivers rules to a
        // fresh client (the 'rules' broadcast only fires on another PUT).
        triggerRules: msg.rules ?? s.triggerRules,
        visibilityPolicy: msg.visibilityPolicy ? { ...s.visibilityPolicy, ...msg.visibilityPolicy } : s.visibilityPolicy,
        ...(msg.weather
          ? {
              weatherAlerts: msg.weather.alerts,
              weatherObs: msg.weather.obs,
              triggerSuggestions: msg.weather.suggestions,
            }
          : {}),
        chats: msg.chats ?? [],
        ...(!scenarioLoaded && s.commsAll ? { commsAll: false } : {}),
        ...(!scenarioLoaded &&
        (s.commsChannel.includes('-') || s.commsChannel === 'papd' || s.commsChannel === 'interagency')
          ? { commsChannel: 'fdny' as const }
          : {}),
      }))
      // Feed layer state rides every snapshot (live data is orthogonal to
      // replay — the health board must stay honest even mid-playback).
      if (msg.feeds) {
        setAppState({
          feedHealth: Object.fromEntries(msg.feeds.health.map((h) => [h.id, h])),
          feedData: Object.fromEntries(msg.feeds.data.map((d) => [d.id, d])),
        })
      }
      // During replay, stop here: the globe/timeline belong to the replay
      // engine; resyncLive() rebuilds them from the server on exit.
      if (getAppState().replay.active) break
      // Authoritative rebuild — clears units/shapes that changed while
      // disconnected (e.g. server restart swept the registry).
      getUnitLayer()?.clear()
      const units: Record<string, Unit> = {}
      for (const u of msg.units ?? []) {
        units[u.uid] = u
        getUnitLayer()?.upsert(u, unitMapVisible(u))
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
      } else if (!msg.incident && prev) {
        // Board reset (END INCIDENT from any station) — full local teardown.
        clearLocalIncident()
      } else {
        setAppState({ incident: msg.incident })
        // Address CORRECTION moved the incident — rebuild the site picture
        // at the new coordinates (shapes/units/timeline stay).
        if (msg.incident && prev && (msg.incident.lat !== prev.lat || msg.incident.lon !== prev.lon)) {
          relocateIncidentSite(msg.incident)
        }
      }
      break
    }
    case 'unit': {
      setAppState((s) => ({ units: { ...s.units, [msg.unit.uid]: msg.unit } }))
      getUnitLayer()?.upsert(msg.unit, unitMapVisible(msg.unit))
      break
    }
    case 'units.batch': {
      // One state write (= one React render pass) for the whole window.
      setAppState((s) => {
        const units = { ...s.units }
        for (const u of msg.units) units[u.uid] = u
        return { units }
      })
      const layer = getUnitLayer()
      for (const u of msg.units) layer?.upsert(u, unitMapVisible(u))
      break
    }
    case 'scenario.status': {
      const loaded = msg.scenario.loaded
      setAppState((s) => ({
        scenario: loaded ? msg.scenario : null,
        // A drill ending must not leave the comms panel on a scenario-only
        // channel that no longer has a tab — nor stuck in the merged ALL view
        // (commsAll with a live channel selected highlights no tab at all).
        ...(!loaded && s.commsAll ? { commsAll: false } : {}),
        ...(!loaded && (s.commsChannel.includes('-') || s.commsChannel === 'papd' || s.commsChannel === 'interagency')
          ? { commsChannel: 'fdny' as const }
          : {}),
      }))
      break
    }
    case 'alert': {
      if (msg.alert.kind === 'clear') {
        setAppState({ alert: null })
      } else {
        setAppState({ alert: msg.alert })
        // Map snaps to the member in trouble — at the alert's OWN captured
        // coordinates (the units store is frozen during replay).
        flyToAlert(msg.alert)
      }
      break
    }
    case 'exposure':
      getExposureLayer()?.set(msg.labels ?? [])
      break
    case 'scenario.aar':
      // The facilitator's HSEEP review owns the screen — the drill's generic
      // AAR popping over it (script end fires during review) reads as a bug.
      if (getAppState().exerciseReview) break
      setAppState({ aarOpen: true })
      break
    case 'chat':
      setAppState((s) =>
        s.chats.some((c) => c.id === msg.msg.id) ? {} : { chats: [...s.chats, msg.msg].slice(-200) },
      )
      break
    case 'dispatch.feed':
      setAppState({ dispatchFeed: msg.incidents })
      break
    case 'portfolio':
      setAppState({ portfolio: msg.incidents })
      break
    case 'ticker':
      // Dedupe by id: a reconnect snapshot plus an in-flight broadcast can
      // deliver the same event twice (same guard the transcript stream has).
      setAppState((s) =>
        s.tickerFeed.some((e) => e.id === msg.event.id)
          ? {} // empty patch engages the store's no-op short-circuit
          : { tickerFeed: [...s.tickerFeed, msg.event].slice(-300) },
      )
      break
    case 'eoc':
      setAppState({ eoc: { level: msg.level, history: msg.history } })
      break
    case 'plans':
      setAppState({ planActivations: msg.plans })
      break
    case 'requests':
      setAppState({ interagencyRequests: msg.requests })
      break
    case 'feed.health': {
      const h = msg.health
      setAppState((s) => ({ feedHealth: { ...s.feedHealth, [h.id]: h } }))
      break
    }
    case 'feed.data': {
      const d = msg.data
      setAppState((s) => ({ feedData: { ...s.feedData, [d.id]: d } }))
      break
    }
    case 'weather':
      setAppState({ weatherAlerts: msg.alerts, weatherObs: msg.obs, triggerSuggestions: msg.suggestions })
      break
    case 'rules':
      setAppState({ triggerRules: msg.rules })
      break
    case 'policy':
      // Hot-reload: the admin editor tightened/relaxed the visibility policy —
      // every gated surface re-renders against it immediately, including the
      // member markers on the globe.
      setAppState((s) => ({ visibilityPolicy: { ...s.visibilityPolicy, ...msg.policy } }))
      applyUnitVisibility()
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
    case 'transcript.reset': {
      // Server-authoritative clear of the drill channels (scenario load, stop,
      // or a backward seek about to re-broadcast the history without dupes).
      setAppState((s) => {
        const transcripts = { ...s.transcripts }
        for (const ch of msg.channels) if (ch in transcripts) transcripts[ch] = []
        return { transcripts }
      })
      break
    }
    case 'transcript': {
      const MAX_LINES = 200
      setAppState((s) => {
        const existing = s.transcripts[msg.channel]
        const last = existing[existing.length - 1]
        // Transport duplication (e.g. stacked dev-reload sockets): the copies
        // can arrive INTERLEAVED (1,2,1,2), so check ids across the whole
        // window — plus the adjacent ts+text check for id-less older servers.
        if (msg.line.id && existing.some((l) => l.id === msg.line.id)) return {}
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
