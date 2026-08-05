import { useRef, useSyncExternalStore } from 'react'
import type { BuildingSafety, CofoRecord, Firehouse, Hydrant, PlutoAttributes } from '../api/nyc'
import type {
  Agency,
  ChatMsg,
  CommsChannel,
  CommsConfig,
  DataLayerId,
  DrawTool,
  FeedIncident,
  GeoHit,
  IcsShape,
  Incident,
  InteragencyRequest,
  LayerStatus,
  MapAlert,
  ProviderMode,
  RequestPriority,
  ScenarioStatus,
  TimelineEvent,
  ToggleLayerId,
  TranscriptLine,
  Unit,
  UnitCategory,
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
  /** Prompt 12 — active workspace profile. All rendering gates flow from the
   *  capability manifest keyed by this. */
  profile: 'fdny' | 'nycem'
  /** Prompt 12 — cross-agency visibility policy (server-owned, hot-reloads). */
  visibilityPolicy: import('../profiles/policy').VisibilityPolicy
  /** Prompt 12 — admin visibility-policy editor. */
  policyEditorOpen: boolean
  /** Incident building STRUCTURE FRAME: footprint center, dominant facade
   *  bearing (deg from north, the building's own axis — NYC's grid is
   *  rotated off true north) and oriented half-extents along/across it.
   *  Battle views aim head-on at faces using THIS, not world axes. */
  targetBounds: { centerLat: number; centerLon: number; bearingA: number; halfA: number; halfB: number } | null
  /** Operator pressed UNLOCK on the rail: camera roams free while the rail
   *  (and floor tracking) stay up; any view button re-locks. */
  viewLockSuspended: boolean
  /** FDNY battle-view lock: top-down or a building side, floors steppable. */
  viewLock: 'off' | 'orbit' | 'top' | 'north' | 'east' | 'south' | 'west'
  /** Auto-orbit paused (LIVE VIEWS ⏸ button). */
  viewLockOrbitPaused: boolean
  /** Current floor for the side (facade) battle views. */
  viewLockFloor: number
  /** Transient operator notice (top-center chip, auto-clears). */
  uiNotice: { text: string; tone: 'amber' | 'red' } | null
  /** Drag offsets per movable panel id (transform-only; {} = default layout). */
  panelOffsets: import('../lib/movable').PanelOffsets
  /** Panels collapsed to their smallest (header-only) state, persisted. */
  panelMinimized: Record<string, boolean>
  /** Active role layout preset key (ic/ops/planning/wall), if one applied. */
  layoutPreset: string | null
  /** Glove-and-distance mode: UI chrome scaled ~35% for cab tablets / walls. */
  gloveMode: boolean
  /** Guided first-run checklist (plain language, self-checking steps). */
  practiceTour: boolean
  /** Swipeable FDNY dashboards: 0 = tactical map, 1 = command board,
   *  2 = riding lists. Pages 1-2 are plain-DOM fallbacks that keep working
   *  even if the 3D view dies. */
  dashboardPage: 0 | 1 | 2 | 3 | 4 | 5
  /** Simulated dispatch audio currently speaking (DISPATCH page). */
  dispatchPlaying: 'fdny' | 'ems' | 'both' | null
  /** Size-up strip tab + face index — in the store (not component state) so
   *  the voice layer and scenario beats can drive them. */
  sizeupTab: 'views' | 'oblique' | 'street'
  sizeupFace: number
  /** 2D basemap — lifted from TacticalMap2D for the same reason. */
  map2dBase: 'dark' | 'light' | 'sat'
  // ---- Prompt 15: push-to-talk voice command layer ------------------------
  /** Mic held and streaming to the ASR tier. */
  voiceListening: boolean
  /** Live partial transcript while the PTT is held. */
  voicePartial: string
  /** Which ASR provider is active ('deepgram' | 'webspeech' | null=idle). */
  voiceAsr: 'deepgram' | 'webspeech' | null
  /** 2-second echo chip after an instant command executes ("→ EXPOSURE 2"). */
  voiceEcho: { text: string; tone: 'ok' | 'warn' } | null
  /** Pending confirm-class command: drafted action awaiting tap/voice CONFIRM.
   *  The confirmation gate lives in the ACTION layer (registry), not here. */
  voiceConfirm: { intent: string; slots: Record<string, string>; draft: string } | null
  /** Speak one-sentence answers to voice queries (default OFF — a tablet
   *  talking over radio traffic is a liability; the user opts in). */
  voiceReplies: boolean
  /** Voice command reference panel (the "what can I say" list). */
  voiceHelpOpen: boolean
  /** Command board: unit uid -> assigned position (ATTACK, SEARCH...). */
  boardAssignments: Record<string, string>
  /** Command board diagram: unit uid -> normalized {x,y} on the building. */
  boardPlacements: Record<string, { x: number; y: number }>
  /** Riding-list PAR checks: unit callsign -> ms epoch of last PAR. */
  parChecks: Record<string, number>
  /** The CAD feed entry the officer pressed to respond (SIMULATED FireCAD). */
  cadIncident: import('../types').FeedIncident | null
  responsePacketOpen: boolean
  /** Portfolio marker the operator is hovering (drives the hover card). */
  interagencyRequests: InteragencyRequest[]
  requestThresholds: Record<RequestPriority, number>
  /** Prompt 13 — feed layer: health per feed id + latest pushed payloads.
   *  Big pull-only lists (camera inventory) are fetched over REST instead. */
  feedHealth: Record<string, import('../types').FeedHealthWire>
  feedData: Record<string, import('../types').FeedDataWire>
  feedPanelOpen: boolean
  /** Shape-tool undo: stack depth + top entry's label (button tooltip). */
  undoDepth: number
  undoLabel: string | null
  /** Facilitator review screen for a finished exercise (M8). */
  /** Unsaved facilitator edits exist in the review — guards lossy unmounts. */
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
  isolateFloors: { z0: number; storeyM: number; floors: number } | null
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
  /** Prompt 14: which tactical renderer owns the incident view. */
  mapMode: '2d' | '3d'
  /** True once the 2D map's style has loaded (boot veil gate). */
  map2dReady: boolean
  /** Renderer-neutral footprint geometry for the 2D map (same fetch the 3D
   *  layer draws from; published by actions when footprints resolve). */
  footprintsGeo: { feats: import('../lib/footprints').Footprint[]; targetBin: string | null } | null
  /** Fresh DOT link speeds near the box (renderer-neutral; 2D + 3D draw it). */
  trafficLinks: { name: string; speedMph: number; asOf: string; positions: [number, number][] }[]
  /** Minutes the DOT feed head trails the wall clock (null = unknown/off). */
  trafficAgeMin: number | null
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
    traffic: true, // DOT live speeds — draws moderate/heavy congestion only
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
  // Single-profile platform: the NYCEM workspace (and its ?profile= launcher)
  // left with the exports/nycem-coordination bundle — a stored or URL-pinned
  // nycem must not strand a browser in a profile with no UI.
  profile: 'fdny' as const,
  visibilityPolicy: { par_member_names: 'full', riding_lists: 'full', radio_channels: 'all' },
  policyEditorOpen: false,
  targetBounds: null,
  viewLock: 'off',
  viewLockOrbitPaused: false,
  viewLockSuspended: false,
  viewLockFloor: 1,
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
  panelMinimized: (() => {
    try {
      const parsed = JSON.parse(localStorage.getItem('ks-panel-min') ?? '{}') as Record<string, boolean>
      return Object.fromEntries(Object.entries(parsed).filter(([, v]) => v === true))
    } catch {
      return {}
    }
  })(),
  layoutPreset: null,
  gloveMode: localStorage.getItem('ks-glove') === '1',
  practiceTour: false,
  dashboardPage: 0,
  dispatchPlaying: null,
  sizeupTab: 'oblique',
  sizeupFace: 0,
  map2dBase: 'dark',
  voiceListening: false,
  voicePartial: '',
  voiceAsr: null,
  voiceEcho: null,
  voiceConfirm: null,
  voiceReplies: localStorage.getItem('ks-voice-replies') === '1',
  voiceHelpOpen: false,
  boardAssignments: (() => {
    try {
      return JSON.parse(localStorage.getItem('ks-board') ?? '{}') as Record<string, string>
    } catch {
      return {}
    }
  })(),
  boardPlacements: (() => {
    try {
      return JSON.parse(localStorage.getItem('ks-board-xy') ?? '{}') as Record<string, { x: number; y: number }>
    } catch {
      return {}
    }
  })(),
  parChecks: {},
  cadIncident: null,
  responsePacketOpen: false,
  interagencyRequests: [],
  requestThresholds: { immediate: 120_000, urgent: 300_000, routine: 1_800_000 },
  feedHealth: {},
  feedData: {},
  feedPanelOpen: false,
  undoDepth: 0,
  undoLabel: null,
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
  // Prompt 14: 2D-first. The manifest keeps this meaningful only for FDNY;
  // ISOLATE flips to '3d' for the building views and back on exit.
  mapMode: '2d',
  map2dReady: false,
  footprintsGeo: null,
  trafficLinks: [],
  trafficAgeMin: null,
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
