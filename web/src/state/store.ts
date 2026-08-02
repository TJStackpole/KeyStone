import { useRef, useSyncExternalStore } from 'react'
import type { BuildingSafety, CofoRecord, Firehouse, Hydrant, PlutoAttributes } from '../api/nyc'
import type {
  Agency,
  ChatMsg,
  CommsChannel,
  CommsConfig,
  DataLayerId,
  DrawTool,
  EocChange,
  EocLevel,
  ExerciseSession,
  FeedIncident,
  GeoHit,
  IcsShape,
  Incident,
  InteragencyRequest,
  LayerStatus,
  MapAlert,
  NwsAlert,
  PlanActivation,
  PortfolioIncident,
  ProviderMode,
  RequestPriority,
  ScenarioStatus,
  TickerEvent,
  TimelineEvent,
  ToggleLayerId,
  TranscriptLine,
  TriggerRule,
  TriggerSuggestion,
  Unit,
  UnitCategory,
  WeatherObsNycem,
} from '../types'

export interface SiteIntel {
  pluto: PlutoAttributes | null
  hydrants: Hydrant[]
  firehouses: Firehouse[]
  safety: BuildingSafety | null
  /** Certificates of Occupancy — the public floor-by-floor record. */
  cofo: CofoRecord[]
}

/** Any building the operator tapped on the map (not the incident building). */
export interface InspectedBuilding {
  hit: GeoHit
  loading: boolean
  pluto: PlutoAttributes | null
  safety: BuildingSafety | null
  cofo: CofoRecord[]
}

export interface AppState {
  sceneReady: boolean
  providerMode: ProviderMode | null
  incident: Incident | null
  layers: Record<DataLayerId, LayerStatus>
  intel: SiteIntel
  inspected: InspectedBuilding | null
  layerToggles: Record<ToggleLayerId, boolean>
  units: Record<string, Unit>
  /** null until the server reports TAK link state. */
  takConnected: boolean | null
  unitToggles: Record<UnitCategory, boolean>
  /**
   * Per-crew member visibility (keyed by parent callsign, e.g. "E-6"):
   * hides that company's individual members on the map. Missing key = shown.
   * ANDed with the category/agency toggles and the GPS policy.
   */
  memberCrewToggles: Record<string, boolean>
  /** Agency-level map filters (NYCEM view) — ANDed with unitToggles. */
  agencyToggles: Record<Agency, boolean>
  /** Master GPS tracking switch: off = no unit dots on the map at all. */
  gpsTracking: boolean
  dispatching: boolean
  shapes: Record<string, IcsShape>
  drawTool: DrawTool
  /** STGE picker: 'auto' = next-due company, else a specific responding callsign. */
  stagingPick: string
  /** Tap-a-building pushes the tapped address into the search bar via this. */
  searchPrefill: string | null
  selectedShapeId: string | null
  /** Right utility dock: one panel, tabbed, no overlaps. */
  utilityTab: 'sitrep' | 'video' | 'bio' | 'floors' | null
  /** Video wall <-> globe highlight sync. */
  selectedUnitUid: string | null
  commsOpen: boolean
  commsChannel: CommsChannel
  transcripts: Record<CommsChannel, TranscriptLine[]>
  /** Merged multi-channel command view in the comms panel. */
  commsAll: boolean
  /**
   * FDNY comms source: 'sim' replays the bundled dispatch recording as-live
   * (demo mode, watermarked SIMULATED); 'live' plays the attached radio feed
   * — selectable only when the server reports one configured.
   */
  commsSource: 'sim' | 'live'
  /** Scenario playback (Prompt 8A) — null until a scenario is loaded. */
  scenario: ScenarioStatus | null
  /** Active full-screen alert (mayday etc.) — null when clear. */
  alert: MapAlert | null
  /** SIMULATED citywide dispatch feed (FDNY/NYPD/PAPD dispatch centers). */
  dispatchFeed: FeedIncident[]
  /** Feed entry the board is currently focused on (null = none/manual). */
  focusedFeedId: string | null
  // ------------------- Prompt 11: NYCEM coordination layer -------------------
  /** Watch Command mode: the citywide multi-incident portfolio view. */
  watchCommand: boolean
  /** Prompt 12 — active workspace profile. All rendering gates flow from the
   *  capability manifest keyed by this. */
  profile: 'fdny' | 'nycem'
  /** Prompt 12 — cross-agency visibility policy (server-owned, hot-reloads). */
  visibilityPolicy: import('../profiles/policy').VisibilityPolicy
  /** Prompt 12 — admin visibility-policy editor. */
  policyEditorOpen: boolean
  /** Transient operator notice (top-center chip, auto-clears). */
  uiNotice: { text: string; tone: 'amber' | 'red' } | null
  /** Drag offsets per movable panel id (transform-only; {} = default layout). */
  panelOffsets: import('../lib/movable').PanelOffsets
  portfolio: PortfolioIncident[]
  /** Portfolio marker the operator is hovering (drives the hover card). */
  portfolioHoverId: string | null
  tickerFeed: TickerEvent[]
  eoc: { level: EocLevel; history: EocChange[] }
  planActivations: PlanActivation[]
  interagencyRequests: InteragencyRequest[]
  requestThresholds: Record<RequestPriority, number>
  weatherAlerts: NwsAlert[]
  weatherObs: WeatherObsNycem | null
  triggerSuggestions: TriggerSuggestion[]
  triggerRules: TriggerRule[]
  /** Facilitator review screen for a finished exercise (M8). */
  exerciseReview: ExerciseSession | null
  /** Unsaved facilitator edits exist in the review — guards lossy unmounts. */
  exerciseReviewDirty: boolean
  /** IC view <-> NYCEM Watch Command coordination view. */
  /** After-action report overlay (auto-opens at scenario end). */
  aarOpen: boolean
  /** TAK GeoChat: every EUD on the TAK server, "All Chat Rooms". */
  chats: ChatMsg[]
  chatOpen: boolean
  /** "Ask the Manuals" doctrine panel (Module 1). */
  manualsOpen: boolean
  /** Building-type tactics panel (Module 3) + the IC's type override. */
  tacticsOpen: boolean
  tacticsOverride: import('../lib/ffpClassify').FfpType | null
  /** Live NWS wind at the incident (Module 4). */
  wind: import('../api/weather').WindObs | null
  commsConfig: CommsConfig | null
  replay: { active: boolean; playing: boolean; t: number; duration: number }
  timeline: TimelineEvent[]
  /** Height of the incident building's footprint (drives the collapse-zone tool). */
  targetHeightM: number | null
  /** ACTIVE INCIDENT focus: refine the fire building, de-emphasize >4 blocks. */
  activeIncidentMode: boolean
  /** ISOLATE: clip away every building/tree except the incident building. */
  isolateMode: boolean
  /** Meters the isolated building is lifted — interior members ride along. */
  isolateLiftM: number
  /** ISOLATE rendering: clean schematic 3D model vs the clipped real imagery. */
  isolateView: 'model' | 'live'
  /** MODEL-view vertical exaggeration (1 / 1.5 / 2×) — easier floor tracking. */
  isolateScale: number
  /**
   * Floor geometry of the CURRENT schematic (base height + scaled storey
   * height) — interior members position by floor against this, so they stay
   * on their floor even when the model is vertically scaled.
   */
  isolateFloors: { z0: number; storeyM: number } | null
  /**
   * True-scale floor geometry of the incident building (street base + real
   * storey height), published once footprints resolve. Interior members
   * position by floor against this OUTSIDE isolate too — far more accurate
   * than trusting raw CoT altitude. isolateFloors overrides it when set.
   */
  floorRef: { z0: number; storeyM: number } | null
  /** Tapped-building schematic (no incident required) is on the globe. */
  inspectedModelOn: boolean
  /** Camera mode: tactical 3D or straight-down satellite-style view. */
  viewMode: '3d' | 'topdown'
  /** Street-level camera dropped by the GND tool. */
  groundViewActive: boolean
  /** Photographic Street View panel (Google embed, key-gated). */
  streetViewOpen: boolean
  /** Eye height above the clicked surface for ground view, feet (0–50). */
  groundViewFt: number
}

const initial: AppState = {
  sceneReady: false,
  providerMode: null,
  incident: null,
  layers: {
    footprints: 'idle',
    pluto: 'idle',
    hydrants: 'idle',
    firehouses: 'idle',
    safety: 'idle',
    persistence: 'idle',
  },
  intel: { pluto: null, hydrants: [], firehouses: [], safety: null, cofo: [] },
  inspected: null,
  layerToggles: {
    footprints: true,
    targetbox: true,
    hydrants: true,
    firehouses: true,
    streets: true,
    traffic: false,
    lots: true, // draws only when zoomed in — see refreshLots' height gate
    roads: true, // yellow road-network overlay, camera-following
    tunnels: true, // the four major vehicular tunnels, citywide
    wind: true, // live NWS wind vector at the incident
    collapsezones: false, // per-face 1.5xH collapse zones (VALIDATE—SME)
    battalions: false,
    divisions: false,
    poiFirehouses: false,
    poiFdny: false,
    poiPrecincts: false,
    poiHospitals: false,
    poiNycem: false,
  },
  units: {},
  takConnected: null,
  unitToggles: {
    engine: true,
    ladder: true,
    battalion: true,
    rescue: true,
    ems: true,
    nypd: true,
    esu: true,
    papd: true,
    oem: true,
    drone: true,
    ff: true,
    officer: true,
    medic: true,
    unknown: true,
  },
  memberCrewToggles: {},
  agencyToggles: { FDNY: true, EMS: true, NYPD: true, PAPD: true, OEM: true, TAK: true },
  gpsTracking: true,
  dispatching: false,
  shapes: {},
  drawTool: null,
  stagingPick: 'auto',
  searchPrefill: null,
  selectedShapeId: null,
  utilityTab: null,
  selectedUnitUid: null,
  commsOpen: true,
  commsChannel: 'fdny',
  transcripts: {
    fdny: [],
    nypd: [],
    ems: [],
    oem: [],
    'fdny-tac': [],
    'fdny-cmd': [],
    'ems-cw': [],
    'nypd-sod': [],
    papd: [],
    interagency: [],
  },
  commsAll: false,
  commsSource: 'sim',
  scenario: null,
  alert: null,
  dispatchFeed: [],
  focusedFeedId: null,
  watchCommand: false,
  // URL param (dual-screen launcher) beats the remembered choice beats FDNY.
  // Inlined rather than imported from profiles/ — the manifest imports THIS
  // module's hooks, and an import back would be a runtime cycle.
  profile: (() => {
    const q = new URLSearchParams(window.location.search).get('profile')
    if (q === 'fdny' || q === 'nycem') return q
    return localStorage.getItem('ks-profile') === 'nycem' ? ('nycem' as const) : ('fdny' as const)
  })(),
  visibilityPolicy: { par_member_names: 'full', riding_lists: 'full', radio_channels: 'all' },
  policyEditorOpen: false,
  uiNotice: null,
  // Inline read (not the lib helper) — movable.tsx imports THIS module.
  panelOffsets: (() => {
    try {
      const parsed = JSON.parse(localStorage.getItem('ks-panel-offsets') ?? '{}') as Record<string, { x: number; y: number }>
      const out: Record<string, { x: number; y: number }> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (v && Number.isFinite(v.x) && Number.isFinite(v.y)) out[k] = { x: v.x, y: v.y }
      }
      return out
    } catch {
      return {}
    }
  })(),
  portfolio: [],
  portfolioHoverId: null,
  tickerFeed: [],
  eoc: { level: 4, history: [] },
  planActivations: [],
  interagencyRequests: [],
  requestThresholds: { immediate: 120_000, urgent: 300_000, routine: 1_800_000 },
  weatherAlerts: [],
  weatherObs: null,
  triggerSuggestions: [],
  triggerRules: [],
  exerciseReview: null,
  exerciseReviewDirty: false,
  aarOpen: false,
  chats: [],
  chatOpen: false,
  manualsOpen: false,
  tacticsOpen: false,
  tacticsOverride: null,
  wind: null,
  commsConfig: null,
  replay: { active: false, playing: false, t: 0, duration: 0 },
  timeline: [],
  targetHeightM: null,
  activeIncidentMode: true,
  isolateMode: false,
  isolateLiftM: 0,
  isolateView: 'model',
  isolateScale: 1,
  isolateFloors: null,
  floorRef: null,
  inspectedModelOn: false,
  viewMode: '3d',
  groundViewActive: false,
  groundViewFt: 6,
  streetViewOpen: false,
}

let state: AppState = initial
const listeners = new Set<() => void>()

export function getAppState(): AppState {
  return state
}

export function setAppState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch
  // Empty patch = deliberate no-op (dedupe guards) — don't wake every
  // subscribed component for nothing.
  if (!next || Object.keys(next).length === 0) return
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

export function setLayerStatus(layer: DataLayerId, status: LayerStatus): void {
  setAppState((s) => ({ layers: { ...s.layers, [layer]: status } }))
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** Non-React subscription (Cesium render-mode controller etc.). */
export const subscribeStore = subscribe

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, getAppState)
}

/**
 * Slice subscription: re-renders only when the SELECTED keys change (shallow
 * compare). The whole-store hook re-renders every subscriber on every store
 * write — during a drill that is units.batch (≤5/s) + scenario.status (1/s)
 * reconciling the entire Watch Command tree for messages it never displays.
 * Selector must return a flat object of store values.
 */
export function useAppSlice<T extends Record<string, unknown>>(selector: (s: AppState) => T): T {
  // Ref-cached snapshot: getSnapshot must return a STABLE reference while the
  // selected values are unchanged, or useSyncExternalStore loops forever.
  const cache = useRef<T | null>(null)
  return useSyncExternalStore(subscribe, () => {
    const next = selector(state)
    const prev = cache.current
    if (prev) {
      let same = true
      for (const k in next) {
        if (!Object.is(prev[k], next[k])) {
          same = false
          break
        }
      }
      if (same) return prev
    }
    cache.current = next
    return next
  })
}

if (import.meta.env.DEV) {
  // Debug handle — dev builds only. (Console `import()` would get a separate
  // module instance under Vite HMR, so expose the live store explicitly.)
  ;(window as unknown as Record<string, unknown>).__wtStore = { getAppState, setAppState }
}
