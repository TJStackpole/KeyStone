import { useSyncExternalStore } from 'react'
import type { Firehouse, Hydrant, PlutoAttributes } from '../api/nyc'
import type {
  DataLayerId,
  DrawTool,
  IcsShape,
  Incident,
  LayerStatus,
  ProviderMode,
  ToggleLayerId,
  Unit,
  UnitCategory,
} from '../types'

export interface SiteIntel {
  pluto: PlutoAttributes | null
  hydrants: Hydrant[]
  firehouses: Firehouse[]
}

export interface AppState {
  sceneReady: boolean
  providerMode: ProviderMode | null
  incident: Incident | null
  layers: Record<DataLayerId, LayerStatus>
  intel: SiteIntel
  layerToggles: Record<ToggleLayerId, boolean>
  units: Record<string, Unit>
  /** null until the server reports TAK link state. */
  takConnected: boolean | null
  unitToggles: Record<UnitCategory, boolean>
  dispatching: boolean
  shapes: Record<string, IcsShape>
  drawTool: DrawTool
  selectedShapeId: string | null
}

const initial: AppState = {
  sceneReady: false,
  providerMode: null,
  incident: null,
  layers: { footprints: 'idle', pluto: 'idle', hydrants: 'idle', firehouses: 'idle', persistence: 'idle' },
  intel: { pluto: null, hydrants: [], firehouses: [] },
  layerToggles: { footprints: true, hydrants: true, firehouses: true },
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
    oem: true,
    drone: true,
    unknown: true,
  },
  dispatching: false,
  shapes: {},
  drawTool: null,
  selectedShapeId: null,
}

let state: AppState = initial
const listeners = new Set<() => void>()

export function getAppState(): AppState {
  return state
}

export function setAppState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const next = typeof patch === 'function' ? patch(state) : patch
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
