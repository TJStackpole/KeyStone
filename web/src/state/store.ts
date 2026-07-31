import { useSyncExternalStore } from 'react'
import type { BuildingSafety, CofoRecord, Firehouse, Hydrant, PlutoAttributes } from '../api/nyc'
import type {
  Agency,
  ChatMsg,
  CommsChannel,
  CommsConfig,
  DataLayerId,
  DrawTool,
  GeoHit,
  IcsShape,
  Incident,
  LayerStatus,
  MapAlert,
  ProviderMode,
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
  /** Scenario playback (Prompt 8A) — null until a scenario is loaded. */
  scenario: ScenarioStatus | null
  /** Active full-screen alert (mayday etc.) — null when clear. */
  alert: MapAlert | null
  /** IC view <-> NYCEM Watch Command coordination view. */
  nycemView: boolean
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
  scenario: null,
  alert: null,
  nycemView: false,
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

export function useAppState(): AppState {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    getAppState,
  )
}

if (import.meta.env.DEV) {
  // Debug handle — dev builds only. (Console `import()` would get a separate
  // module instance under Vite HMR, so expose the live store explicitly.)
  ;(window as unknown as Record<string, unknown>).__wtStore = { getAppState, setAppState }
}
