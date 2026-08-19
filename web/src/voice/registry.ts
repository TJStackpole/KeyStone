// ---------------------------------------------------------------------------
// Prompt 15 — the voice ACTION layer, with the safety split enforced HERE.
//
//   instant  — view changes, layer toggles, panel navigation, read queries.
//              Executed immediately; a 2-second echo chip is the only output.
//   confirm  — anything that changes incident state or initiates comms.
//              executeIntent() only DRAFTS these (voiceConfirm chip); nothing
//              runs until confirmPending() — a tap on CONFIRM or a held-PTT
//              "confirm". Because the gate lives in this layer, no voice path
//              (grammar, LLM fallback, scenario injection) can bypass it.
//   deny     — PAR confirmation, mayday acknowledgement, riding-list edits.
//              Tap-only per the transcription-safety doctrine. Voice NEVER
//              executes these; the refusal explains where to tap.
//
// Action imports are lazy (inside run/commit) so this module stays a pure,
// testable table — the deny-list tests run without dragging in Cesium.
// ---------------------------------------------------------------------------

import { PANEL_IDS, resetPanelLayout, setAllPanelsMinimized, setPanelMinimized } from '../lib/movable'
import { isApparatus, isAtBox } from '../lib/crews'
import { getAppState, setAppState } from '../state/store'
import { exposureDigit, PANEL_ALIASES, parseUnitPhrase } from './grammar'
import type { Unit } from '../types'

export type IntentClass = 'instant' | 'confirm' | 'deny' | 'query'

export interface ExecResult {
  ok: boolean
  /** Echo chip text ("→ EXPOSURE 2"). */
  echo: string
  /** Optional one-sentence spoken reply (only used when voiceReplies is on). */
  speak?: string
  tone?: 'ok' | 'warn'
}

export interface IntentDef {
  klass: IntentClass
  /** Tool description for the Tier B closed schema. */
  description: string
  /** Slot schema for Tier B (strict tool inputs). */
  slots?: Record<string, { description: string; enum?: string[] }>
  /** instant + query executors. */
  run?: (slots: Record<string, string>) => Promise<ExecResult> | ExecResult
  /** confirm class: human-readable statement of the drafted action. */
  draft?: (slots: Record<string, string>) => string | null
  /** confirm class: the gated executor. */
  commit?: (slots: Record<string, string>) => Promise<ExecResult> | ExecResult
  /** deny class: why this stays tap-only. */
  denyReason?: string
}

// ---- shared helpers ---------------------------------------------------------

const FACE_ORDER = ['north', 'east', 'south', 'west'] as const
const SIDE_ALIASES: Record<string, string> = {
  front: 'south', rear: 'north', back: 'north', left: 'east', right: 'west',
}

function distM(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * 111_320
  const dLon = (bLon - aLon) * 111_320 * Math.cos((aLat * Math.PI) / 180)
  return Math.hypot(dLat, dLon)
}

function ageS(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
}

/** Resolve a spoken unit phrase against the ACTUAL tracked roster; on a miss,
 *  suggest the nearest same-type callsign ("Did you mean Ladder 26?"). */
export function resolveUnit(phrase: string): { unit?: Unit; suggestion?: string } {
  const parsed = parseUnitPhrase(phrase.toLowerCase())
  if (!parsed) return {}
  const want = `${parsed.prefix}${parsed.num}`.toUpperCase()
  const units = Object.values(getAppState().units)
  const norm = (cs: string) => cs.replace(/[^A-Z0-9]/gi, '').toUpperCase()
  const exact = units.find((u) => norm(u.callsign) === want)
  if (exact) return { unit: exact }
  const sameType = units.filter((u) => norm(u.callsign).replace(/\d+$/, '') === parsed.prefix.toUpperCase())
  if (sameType.length) {
    const nearest = sameType.reduce((a, b) => {
      const na = Number(norm(a.callsign).replace(/^\D+/, '')) || 0
      const nb = Number(norm(b.callsign).replace(/^\D+/, '')) || 0
      const n = Number(parsed.num)
      return Math.abs(nb - n) < Math.abs(na - n) ? b : a
    })
    return { suggestion: nearest.callsign }
  }
  return {}
}

/** ETA for an enroute unit from live track data (no CAD ETA feed exists —
 *  distance over ground speed, urban-response floor when the fix is stale). */
export function unitEtaMin(u: Unit): number | null {
  const inc = getAppState().incident
  if (!inc) return null
  const d = distM(u.lat, u.lon, inc.lat, inc.lon)
  if (d < 120) return 0
  const speed = (u.speed ?? 0) > 1 ? (u.speed as number) : 8 // m/s; ~18 mph floor
  return Math.max(1, Math.round(d / speed / 60))
}

function setLayer(layerWord: string, on: boolean): ExecResult {
  const aliases: Record<string, import('../types').ToggleLayerId> = {
    hydrant: 'hydrants', hydrants: 'hydrants',
    traffic: 'traffic',
    'street name': 'streets', 'street names': 'streets', street: 'streets', streets: 'streets',
    road: 'roads', roads: 'roads', 'road network': 'roads',
    tunnel: 'tunnels', tunnels: 'tunnels',
    lot: 'lots', lots: 'lots', 'tax lots': 'lots',
    wind: 'wind',
    'collapse zone': 'collapsezones', 'collapse zones': 'collapsezones',
    battalion: 'battalions', battalions: 'battalions',
    division: 'divisions', divisions: 'divisions',
    firehouses: 'poiFirehouses',
    'fdny buildings': 'poiFdny',
    precincts: 'poiPrecincts',
    hospitals: 'poiHospitals',
    footprints: 'footprints', buildings: 'footprints',
    'target box': 'targetbox',
  }
  const id = aliases[layerWord]
  if (!id) return { ok: false, echo: `NO LAYER "${layerWord.toUpperCase()}"`, tone: 'warn' }
  // Only wind arrows and the TB collapse advisory are genuinely 3D-only;
  // street names are always-on basemap furniture on the 2D map. Everything
  // else renders on both surfaces (map2d/overlays.ts).
  const st = getAppState()
  const on2d = st.mapMode === '2d'
  if (on && on2d && (id === 'wind' || id === 'collapsezones')) {
    return { ok: false, echo: `${id.toUpperCase()} IS A 3D-VIEW LAYER — SWITCH TO THE 3D MAP FIRST`, tone: 'warn' }
  }
  if (on && on2d && id === 'streets') {
    return { ok: true, echo: 'STREET NAMES ARE ALWAYS ON THE TACTICAL MAP' }
  }
  const cur = st.layerToggles[id]
  if (cur !== on) {
    void import('../actions').then((a) => a.toggleLayer(id))
  }
  return { ok: true, echo: `${id.replace(/^poi/, '').toUpperCase()} ${on ? 'ON' : 'OFF'}` }
}

function openPost(kind: 'command' | 'staging'): ExecResult {
  const shapes = Object.values(getAppState().shapes)
  const post = shapes.find(
    (s) =>
      s.kind === 'post' &&
      (String((s as { post?: string }).post ?? '').includes(kind) ||
        String((s as { label?: string }).label ?? '').toLowerCase().includes(kind === 'command' ? 'command' : 'stag')),
  ) as { lat?: number; lon?: number } | undefined
  if (!post?.lat || !post?.lon) {
    return { ok: false, echo: `NO ${kind === 'command' ? 'COMMAND POST' : 'STAGING'} ON THE MAP`, tone: 'warn' }
  }
  void import('../actions').then((a) => a.flyToFeature(post.lat as number, post.lon as number))
  return { ok: true, echo: kind === 'command' ? '→ COMMAND POST' : '→ STAGING' }
}

const PAGES: Record<string, 0 | 1 | 2 | 3 | 4 | 5> = {
  map: 0, 'tactical map': 0,
  board: 1, 'command board': 1,
  'riding list': 2, 'riding lists': 2,
  log: 3, 'decision log': 3,
  resources: 4, ledger: 4, 'resource ledger': 4,
  dispatch: 5, 'dispatch comms': 5,
  // The requests tracker lives on the DECISION LOG page.
  requests: 3, 'request tracker': 3,
}

async function showFace(faceIdx: number): Promise<ExecResult> {
  const s = getAppState()
  if (!s.incident) return { ok: false, echo: 'NO ACTIVE INCIDENT', tone: 'warn' }
  setAppState({ sizeupTab: 'oblique', sizeupFace: ((faceIdx % 4) + 4) % 4 })
  const a = await import('../actions')
  a.goToIncident()
  return { ok: true, echo: `→ EXPOSURE ${(((faceIdx % 4) + 4) % 4) + 1}` }
}

// ---- the registry -----------------------------------------------------------

/** The rooms that actually exist on the TAK server — anything else reroutes
 *  to ALL and the echo says so instead of claiming a private room. */
const TAK_ROOMS = ['FDNY', 'NYPD', 'EMS', 'PAPD', 'OEM'] as const
function takRoom(agency?: string): string | null {
  const up = (agency ?? '').toUpperCase()
  return (TAK_ROOMS as readonly string[]).includes(up) ? up : null
}

/** Camera locks only mean anything with the ISOLATE 3D view up — writing
 *  lock state with no visible effect makes voice look broken. */
function requireIsolate(): { ok: false; echo: string; tone: 'warn' } | null {
  if (!getAppState().isolateMode) {
    return { ok: false, echo: 'ISOLATE THE BUILDING FIRST — say "isolate the building"', tone: 'warn' }
  }
  return null
}

export const INTENTS: Record<string, IntentDef> = {
  // ---- size-up -------------------------------------------------------------
  show_exposure: {
    klass: 'instant',
    description: 'Rotate the oblique size-up view to exposure 1, 2, 3, or 4 and pan the map to the building.',
    slots: { n: { description: 'Exposure number', enum: ['1', '2', '3', '4'] } },
    run: (slots) => {
      const n = exposureDigit(slots.n ?? '')
      if (!n) return { ok: false, echo: 'WHICH EXPOSURE?', tone: 'warn' }
      return showFace(n - 1)
    },
  },
  show_side: {
    klass: 'instant',
    description: 'Rotate the oblique size-up view to a named building side (north/south/east/west/front/rear).',
    slots: { side: { description: 'Building side', enum: ['north', 'south', 'east', 'west', 'front', 'rear', 'back', 'left', 'right'] } },
    run: (slots) => {
      const side = SIDE_ALIASES[slots.side] ?? slots.side
      const idx = FACE_ORDER.indexOf(side as (typeof FACE_ORDER)[number])
      if (idx < 0) return { ok: false, echo: 'WHICH SIDE?', tone: 'warn' }
      return showFace(idx)
    },
  },
  street_view: {
    klass: 'instant',
    description: 'Open the rotatable Street View panorama of the incident block.',
    run: () => {
      if (!getAppState().incident) return { ok: false, echo: 'NO ACTIVE INCIDENT', tone: 'warn' }
      setAppState({ sizeupTab: 'street' })
      return { ok: true, echo: '→ STREET VIEW' }
    },
  },
  oblique_view: {
    klass: 'instant',
    description: 'Open the oblique aerial imagery tab of the size-up strip.',
    run: () => {
      setAppState({ sizeupTab: 'oblique' })
      return { ok: true, echo: '→ OBLIQUE' }
    },
  },
  assign_exposures: {
    klass: 'confirm',
    description: 'Officer designation: set exposure 1 on a street side, 2-3-4 numbered clockwise. Changes shared incident state.',
    slots: { side: { description: 'Street side that becomes EXPOSURE 1', enum: ['north', 'south', 'east', 'west'] } },
    draft: (slots) => `ASSIGN EXPOSURES — EXP 1 = ${(slots.side ?? 'south').toUpperCase()} SIDE, 2-3-4 CLOCKWISE`,
    commit: async (slots) => {
      const heading = { north: 0, east: 90, south: 180, west: 270 }[slots.side ?? 'south'] ?? 180
      const a = await import('../actions')
      await a.placeExposureLabels(heading)
      return { ok: true, echo: `EXPOSURES ASSIGNED · EXP 1 ${(slots.side ?? 'south').toUpperCase()}` }
    },
  },

  // ---- camera --------------------------------------------------------------
  isolate_on: {
    klass: 'instant',
    description: 'Enter ISOLATE mode: clip the map to the incident building.',
    run: async () => {
      const s = getAppState()
      if (!s.incident) return { ok: false, echo: 'NO ACTIVE INCIDENT', tone: 'warn' }
      if (!s.isolateMode) {
        const applied = (await import('../actions')).toggleIsolateMode()
        if (!applied) return { ok: false, echo: 'ISOLATE NOT READY — see the notice on screen', tone: 'warn' }
      }
      return { ok: true, echo: 'ISOLATE ON' }
    },
  },
  isolate_off: {
    klass: 'instant',
    description: 'Exit ISOLATE mode and return to the tactical map.',
    run: async () => {
      if (getAppState().isolateMode) (await import('../actions')).toggleIsolateMode()
      return { ok: true, echo: 'ISOLATE OFF' }
    },
  },
  live_view: {
    klass: 'instant',
    description: 'Open the LIVE VIEWS camera rail (auto-orbit of the isolated building).',
    run: async () => {
      setAppState({ sizeupTab: 'views' })
      const s = getAppState()
      if (s.isolateMode && s.viewLock === 'off') (await import('../cesium/viewLock')).setViewLockMode('orbit')
      return { ok: true, echo: '→ LIVE VIEWS' }
    },
  },
  orbit: {
    klass: 'instant',
    description: 'Start or resume the auto-rotating orbit around the isolated building.',
    run: async () => {
      const denied = requireIsolate()
      if (denied) return denied
      const vl = await import('../cesium/viewLock')
      if (getAppState().viewLock !== 'orbit') vl.setViewLockMode('orbit')
      vl.setOrbitPaused(false)
      return { ok: true, echo: 'ORBIT' }
    },
  },
  orbit_pause: {
    klass: 'instant',
    description: 'Pause the auto-rotating orbit.',
    run: async () => {
      const denied = requireIsolate()
      if (denied) return denied
      ;(await import('../cesium/viewLock')).setOrbitPaused(true)
      return { ok: true, echo: 'ORBIT PAUSED' }
    },
  },
  lock_top: {
    klass: 'instant',
    description: 'Lock the camera to the top-down plan view of the building.',
    run: async () => {
      const denied = requireIsolate()
      if (denied) return denied
      ;(await import('../cesium/viewLock')).setViewLockMode('top')
      return { ok: true, echo: 'TOP-DOWN' }
    },
  },
  lock_face: {
    klass: 'instant',
    description: 'Lock the camera head-on to a cardinal facade of the building.',
    slots: { side: { description: 'Facade', enum: ['north', 'east', 'south', 'west'] } },
    run: async (slots) => {
      const denied = requireIsolate()
      if (denied) return denied
      const side = slots.side as 'north' | 'east' | 'south' | 'west'
      if (!side) return { ok: false, echo: 'WHICH FACE?', tone: 'warn' }
      ;(await import('../cesium/viewLock')).setViewLockMode(side)
      return { ok: true, echo: `LOCKED ${side.toUpperCase()}` }
    },
  },
  unlock_camera: {
    klass: 'instant',
    description: 'Release the camera to roam freely (the view rail stays up).',
    run: async () => {
      ;(await import('../cesium/viewLock')).setViewLockSuspended(true)
      return { ok: true, echo: 'CAMERA FREE' }
    },
  },
  floor_up: {
    klass: 'instant',
    description: 'Move the facade view up one floor.',
    run: async () => {
      const denied = requireIsolate()
      if (denied) return denied
      ;(await import('../cesium/viewLock')).stepViewLockFloor(1)
      return { ok: true, echo: `FLOOR ${getAppState().viewLockFloor}` }
    },
  },
  floor_down: {
    klass: 'instant',
    description: 'Move the facade view down one floor.',
    run: async () => {
      const denied = requireIsolate()
      if (denied) return denied
      ;(await import('../cesium/viewLock')).stepViewLockFloor(-1)
      return { ok: true, echo: `FLOOR ${getAppState().viewLockFloor}` }
    },
  },
  floor_set: {
    klass: 'instant',
    description: 'Jump the facade view to a specific floor number.',
    slots: { floor: { description: 'Floor number (1-based)' } },
    run: async (slots) => {
      const denied = requireIsolate()
      if (denied) return denied
      const fl = Number(slots.floor)
      if (!Number.isFinite(fl) || fl < 1) return { ok: false, echo: 'WHICH FLOOR?', tone: 'warn' }
      ;(await import('../cesium/viewLock')).jumpViewLockFloor(fl)
      return { ok: true, echo: `FLOOR ${getAppState().viewLockFloor}` }
    },
  },

  // ---- map navigation --------------------------------------------------------
  zoom_building: {
    klass: 'instant',
    description: 'Pan/zoom the map to the incident building.',
    run: async () => {
      const inc = getAppState().incident
      if (!inc) return { ok: false, echo: 'NO ACTIVE INCIDENT', tone: 'warn' }
      const { map2dActive } = await import('../map2d/controller')
      if (getAppState().mapMode === '2d' && map2dActive()) {
        ;(await import('../actions')).flyToFeature(inc.lat, inc.lon)
      } else {
        // goToIncident also unwinds ground view / top-down before flying.
        ;(await import('../actions')).goToIncident()
      }
      return { ok: true, echo: '→ BUILDING' }
    },
  },
  zoom_staging: {
    klass: 'instant',
    description: 'Pan the map to the staging area post.',
    run: () => openPost('staging'),
  },
  zoom_cp: {
    klass: 'instant',
    description: 'Pan the map to the command post.',
    run: () => openPost('command'),
  },
  zoom_unit: {
    klass: 'instant',
    description: 'Pan the map to a unit by designator (e.g. Ladder 118).',
    slots: { unit: { description: 'Spoken unit designator, e.g. "engine 10"' } },
    run: async (slots) => {
      const { unit, suggestion } = resolveUnit(slots.unit ?? '')
      if (!unit) {
        return {
          ok: false,
          echo: suggestion ? `NOT ON SCENE — DID YOU MEAN ${suggestion}?` : 'UNIT NOT TRACKED',
          tone: 'warn',
        }
      }
      ;(await import('../actions')).flyToUnit(unit.uid)
      return { ok: true, echo: `→ ${unit.callsign}` }
    },
  },
  where_is_unit: {
    klass: 'query',
    description: 'Highlight a unit and report its status, last position age, and ETA if enroute.',
    slots: { unit: { description: 'Spoken unit designator, e.g. "ladder 118"' } },
    run: async (slots) => {
      const { unit, suggestion } = resolveUnit(slots.unit ?? '')
      if (!unit) {
        return {
          ok: false,
          echo: suggestion ? `NOT ON SCENE — DID YOU MEAN ${suggestion}?` : 'UNIT NOT TRACKED',
          speak: suggestion ? `Not tracked. Did you mean ${suggestion}?` : 'That unit is not tracked.',
          tone: 'warn',
        }
      }
      ;(await import('../actions')).flyToUnit(unit.uid)
      const status = (unit.status ?? 'tracked').toUpperCase()
      const eta = status === 'ENROUTE' ? unitEtaMin(unit) : null
      const echo = `${unit.callsign} · ${status}${eta !== null ? ` · ~${eta} MIN` : ''} · SEEN ${ageS(unit.updatedAt)}S AGO`
      return { ok: true, echo, speak: `${unit.callsign}, ${status.toLowerCase()}${eta !== null ? `, about ${eta} minutes out` : ''}.` }
    },
  },
  go_home: {
    klass: 'instant',
    description: 'Return the map to the citywide home view.',
    run: async () => {
      const st = getAppState()
      const { map2dActive, flyTo2D } = await import('../map2d/controller')
      if (st.mapMode === '2d' && map2dActive()) flyTo2D(40.7127, -74.006, 11.5)
      else (await import('../actions')).goHome()
      return { ok: true, echo: '→ HOME' }
    },
  },
  north_up: {
    klass: 'instant',
    description: 'Reorient the camera to north-up.',
    run: async () => {
      const st = getAppState()
      const { map2dActive } = await import('../map2d/controller')
      if (st.mapMode === '2d' && map2dActive()) return { ok: true, echo: 'NORTH IS ALWAYS UP ON THE TACTICAL MAP' }
      ;(await import('../actions')).reorientNorth()
      return { ok: true, echo: 'NORTH UP' }
    },
  },

  // ---- layers + basemap -------------------------------------------------------
  layer_show: {
    klass: 'instant',
    description: 'Turn a map layer on (hydrants, traffic, street names, collapse zones, battalions...).',
    slots: { layer: { description: 'Layer name as spoken' } },
    run: (slots) => setLayer(slots.layer ?? '', true),
  },
  layer_hide: {
    klass: 'instant',
    description: 'Turn a map layer off.',
    slots: { layer: { description: 'Layer name as spoken' } },
    run: (slots) => setLayer(slots.layer ?? '', false),
  },
  base_sat: {
    klass: 'instant',
    description: 'Switch the 2D basemap to satellite orthoimagery.',
    run: () => {
      setAppState({ map2dBase: 'sat' })
      return { ok: true, echo: 'BASEMAP SAT' }
    },
  },
  base_dark: {
    klass: 'instant',
    description: 'Switch the 2D basemap to the dark tactical style.',
    run: () => {
      setAppState({ map2dBase: 'dark' })
      return { ok: true, echo: 'BASEMAP DARK' }
    },
  },
  base_light: {
    klass: 'instant',
    description: 'Switch the 2D basemap to the light daylight style.',
    run: () => {
      setAppState({ map2dBase: 'light' })
      return { ok: true, echo: 'BASEMAP LIGHT' }
    },
  },

  // ---- pages + panels ----------------------------------------------------------
  open_page: {
    klass: 'instant',
    description: 'Switch dashboards: tactical map, command board, riding list, decision log, resource ledger, dispatch comms.',
    slots: { page: { description: 'Dashboard name', enum: Object.keys(PAGES) } },
    run: async (slots) => {
      const page = PAGES[slots.page ?? '']
      if (page === undefined) return { ok: false, echo: 'WHICH PAGE?', tone: 'warn' }
      ;(await import('../lib/layouts')).setDashboardPage(page)
      return { ok: true, echo: `→ ${(slots.page ?? '').toUpperCase()}` }
    },
  },
  minimize_panel: {
    klass: 'instant',
    description: 'Minimize (collapse to its header) a named panel on the map: comms, units, incident, site intel, video dock, tools, feeds, chat...',
    slots: { panel: { description: 'Panel name as spoken', enum: PANEL_ALIASES } },
    run: (slots) => setPanelMin(slots.panel ?? '', true),
  },
  restore_panel: {
    klass: 'instant',
    description: 'Restore (expand) a minimized panel by name.',
    slots: { panel: { description: 'Panel name as spoken', enum: PANEL_ALIASES } },
    run: (slots) => setPanelMin(slots.panel ?? '', false),
  },
  minimize_all: {
    klass: 'instant',
    description: 'Minimize every panel on the map platform — clears the screen to headers only.',
    run: () => {
      setAllPanelsMinimized(true)
      return { ok: true, echo: 'ALL PANELS MINIMIZED' }
    },
  },
  restore_all: {
    klass: 'instant',
    description: 'Restore every minimized panel.',
    run: () => {
      setAllPanelsMinimized(false)
      return { ok: true, echo: 'ALL PANELS RESTORED' }
    },
  },
  reset_layout: {
    klass: 'instant',
    description: 'Reset the panel layout: every box returns to its default position and size.',
    run: () => {
      resetPanelLayout()
      return { ok: true, echo: 'LAYOUT RESET' }
    },
  },
  start_par: {
    klass: 'instant',
    description: 'Open the RIDING LIST where PAR is taken. (PAR stamps themselves stay tap-only.)',
    run: async () => {
      ;(await import('../lib/layouts')).setDashboardPage(2)
      return { ok: true, echo: 'RIDING LIST UP — STAMP PAR ✓ PER COMPANY (TAP-ONLY)' }
    },
  },
  open_comms: {
    klass: 'instant',
    description: 'Open the radio comms/transcript panel.',
    run: () => {
      setAppState({ commsOpen: true })
      return { ok: true, echo: '→ COMMS' }
    },
  },
  open_tactics: {
    klass: 'instant',
    description: 'Open the tactics engine panel.',
    run: () => {
      setAppState({ tacticsOpen: true })
      return { ok: true, echo: '→ TACTICS' }
    },
  },
  open_manuals: {
    klass: 'instant',
    description: 'Open the Ask-the-Manuals doctrine panel.',
    run: () => {
      setAppState({ manualsOpen: true })
      return { ok: true, echo: '→ MANUALS' }
    },
  },
  open_feeds: {
    klass: 'instant',
    description: 'Open the live feed health board.',
    run: () => {
      setAppState({ feedPanelOpen: true })
      return { ok: true, echo: '→ FEEDS' }
    },
  },
  open_packet: {
    klass: 'instant',
    description: 'Open the CAD response packet.',
    run: () => {
      setAppState({ responsePacketOpen: true })
      return { ok: true, echo: '→ RESPONSE PACKET' }
    },
  },
  open_street_panel: {
    klass: 'instant',
    description: 'Open the photographic street view panel (3D view).',
    run: () => {
      setAppState({ streetViewOpen: true })
      return { ok: true, echo: '→ STREET PANEL' }
    },
  },

  // ---- dispatch audio -----------------------------------------------------------
  dispatch_play: {
    klass: 'instant',
    description: 'Play the simulated dispatch audio for the active incident (FDNY, EMS, or full).',
    slots: { which: { description: 'Which dispatch', enum: ['fdny', 'fire', 'ems', 'full'] } },
    run: async (slots) => {
      const kind = slots.which === 'ems' ? 'ems' : slots.which === 'fdny' || slots.which === 'fire' ? 'fdny' : 'both'
      const ok = (await import('../lib/dispatchAudio')).playDispatch(kind as 'fdny' | 'ems' | 'both')
      return ok
        ? { ok: true, echo: `▶ ${kind.toUpperCase()} DISPATCH · SIMULATED` }
        : { ok: false, echo: 'NO ACTIVE INCIDENT', tone: 'warn' }
    },
  },
  dispatch_stop: {
    klass: 'instant',
    description: 'Stop the simulated dispatch audio.',
    run: async () => {
      ;(await import('../lib/dispatchAudio')).stopDispatch()
      return { ok: true, echo: '■ AUDIO STOPPED' }
    },
  },

  // ---- comms + requests (CONFIRM) -------------------------------------------------
  tak_open: {
    klass: 'confirm',
    description: 'Open TAK GeoChat scoped to an agency room. Initiates comms, so it is drafted and requires confirmation.',
    slots: { agency: { description: 'Agency room', enum: ['nypd', 'papd', 'ems', 'fdny', 'oem', 'nycem'] } },
    draft: (slots) => `OPEN TAK CHAT — ${takRoom(slots.agency) ?? 'ALL CHAT ROOMS'}`,
    commit: (slots) => {
      const room = takRoom(slots.agency)
      setAppState({ chatOpen: true, chatRoomRequest: room ?? 'All Chat Rooms' })
      return { ok: true, echo: `TAK CHAT OPEN · ${room ?? 'ALL ROOMS'}` }
    },
  },
  tak_send: {
    klass: 'confirm',
    description: 'Send a TAK GeoChat message to an agency room. Drafted for review; nothing transmits until confirmed.',
    slots: {
      agency: { description: 'Agency room', enum: ['nypd', 'papd', 'ems', 'fdny', 'oem', 'nycem'] },
      message: { description: 'Message text to send' },
    },
    draft: (slots) => (slots.message ? `TAK → ${(slots.agency ?? '').toUpperCase()}: “${slots.message}”` : null),
    commit: async (slots) => {
      const room = takRoom(slots.agency)
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: slots.message, room: room ?? 'All Chat Rooms' }),
      })
      setAppState({ chatOpen: true, chatRoomRequest: room ?? 'All Chat Rooms' })
      if (!res.ok) return { ok: false, echo: 'TAK SEND FAILED', tone: 'warn' }
      // No dedicated room for that agency on the server — say where it went.
      return room
        ? { ok: true, echo: `SENT → ${room}` }
        : { ok: true, echo: `SENT → ALL CHAT ROOMS (NO ${(slots.agency ?? '').toUpperCase()} ROOM)` }
    },
  },
  request_resource: {
    klass: 'confirm',
    description: 'Draft an interagency resource request (e.g. "request a bus from EMS"). Requires confirmation.',
    slots: {
      desc: { description: 'What is being requested' },
      agency: { description: 'Agency to task', enum: ['nypd', 'papd', 'ems', 'nycem', 'oem', 'dot', 'con ed'] },
    },
    draft: (slots) => (slots.desc ? `REQUEST — “${slots.desc}” FROM ${(slots.agency ?? '').toUpperCase()}` : null),
    commit: async (slots) => {
      const a = await import('../actions')
      const ok = await a.openInteragencyRequest({
        incidentId: getAppState().incident?.id ?? null,
        requestingAgency: 'FDNY',
        assignedAgency: (slots.agency ?? '').toUpperCase(),
        description: slots.desc ?? '',
        priority: 'routine',
        createdBy: 'VOICE (IC)',
      })
      return ok
        ? { ok: true, echo: `REQUEST OPENED → ${(slots.agency ?? '').toUpperCase()}` }
        : { ok: false, echo: 'REQUEST FAILED', tone: 'warn' }
    },
  },

  // ---- incident lifecycle (CONFIRM) -------------------------------------------------
  transmit_alarm: {
    klass: 'confirm',
    description: 'Transmit a greater alarm (2nd through 5th). Changes incident state; requires confirmation.',
    slots: { alarm: { description: 'Alarm level', enum: ['2nd', '3rd', '4th', '5th', 'second', 'third', 'fourth', 'fifth'] } },
    draft: (slots) => {
      const lv = normalizeAlarm(slots.alarm)
      return lv ? `TRANSMIT ${lv.toUpperCase()} ALARM` : null
    },
    commit: async (slots) => {
      const lv = normalizeAlarm(slots.alarm)
      if (!lv) return { ok: false, echo: 'WHICH ALARM?', tone: 'warn' }
      const sent = await (await import('../actions')).transmitAlarm(lv)
      return sent
        ? { ok: true, echo: `${lv.toUpperCase()} ALARM TRANSMITTED` }
        : { ok: false, echo: `${lv.toUpperCase()} ALARM REFUSED — see the notice`, tone: 'warn' }
    },
  },
  respond_box: {
    klass: 'confirm',
    description: 'Press a CAD box from the citywide feed and respond: flies the board and builds the response packet.',
    slots: { box: { description: 'The feed row to respond to — spoken box/battalion number' } },
    draft: (slots) => {
      const fi = findFeedIncident(slots.box)
      return fi ? `RESPOND — ${fi.type.toUpperCase()} · ${fi.address.toUpperCase()}` : null
    },
    commit: async (slots) => {
      const fi = findFeedIncident(slots.box)
      if (!fi) return { ok: false, echo: 'BOX NOT IN THE FEED', tone: 'warn' }
      await (await import('../actions')).focusFeedIncident(fi)
      return { ok: true, echo: `RESPONDING · ${fi.address.toUpperCase()}` }
    },
  },
  end_incident: {
    klass: 'confirm',
    description: 'End the active incident and stand the board down. Requires confirmation.',
    draft: () => {
      const inc = getAppState().incident
      return inc ? `END INCIDENT — ${inc.address.toUpperCase()}` : null
    },
    commit: async () => {
      await (await import('../actions')).endIncident()
      return { ok: true, echo: 'INCIDENT ENDED' }
    },
  },
  run_demo: {
    klass: 'confirm',
    description: 'Run the one-click demo scenario (structural fire, 100 Gold St). Requires confirmation.',
    draft: () => 'RUN DEMO — STRUCTURAL FIRE, 100 GOLD ST',
    commit: async () => {
      await (await import('../actions')).runDemoScenario()
      return { ok: true, echo: 'DEMO RUNNING' }
    },
  },
  stop_scenario: {
    klass: 'confirm',
    description: 'Stop the running drill/demo scenario. Requires confirmation.',
    draft: () => 'STOP THE RUNNING SCENARIO',
    commit: async () => {
      await (await import('../actions')).stopScenario()
      return { ok: true, echo: 'SCENARIO STOPPED' }
    },
  },

  // ---- voice layer ------------------------------------------------------------------
  replies_on: {
    klass: 'instant',
    description: 'Enable spoken one-sentence replies to voice queries.',
    run: () => {
      setAppState({ voiceReplies: true })
      localStorage.setItem('ks-voice-replies', '1')
      return { ok: true, echo: 'VOICE REPLIES ON', speak: 'Voice replies on.' }
    },
  },
  replies_off: {
    klass: 'instant',
    description: 'Disable spoken replies (visual output only).',
    run: () => {
      setAppState({ voiceReplies: false })
      localStorage.setItem('ks-voice-replies', '0')
      return { ok: true, echo: 'VOICE REPLIES OFF' }
    },
  },
  advanced_toggle: {
    klass: 'instant',
    description: 'Switch between the simple COMMAND view and the full ADVANCED toolset.',
    slots: { state: { description: 'on, off, or command (= off)', enum: ['on', 'off', 'command'] } },
    run: (slots) => {
      // Tier-B may omit the slot entirely — treat that as a toggle rather
      // than silently forcing COMMAND mode.
      const st = typeof slots.state === 'string' ? slots.state : ''
      const on = st === 'on' ? true : st === 'off' || st === 'command' ? false : !getAppState().uiAdvanced
      setAppState({ uiAdvanced: on })
      try {
        localStorage.setItem('ks-advanced', on ? '1' : '0')
      } catch {
        /* private-mode storage — session-only is fine */
      }
      return { ok: true, echo: on ? 'ADVANCED MODE' : 'COMMAND MODE' }
    },
  },
  glove_toggle: {
    klass: 'instant',
    description: 'Toggle glove mode (scaled-up UI chrome).',
    slots: { state: { description: 'on or off', enum: ['on', 'off'] } },
    run: (slots) => {
      const on = slots.state !== 'off'
      setAppState({ gloveMode: on })
      localStorage.setItem('ks-glove', on ? '1' : '0')
      return { ok: true, echo: `GLOVE MODE ${on ? 'ON' : 'OFF'}` }
    },
  },
  voice_help: {
    klass: 'instant',
    description: 'Show the voice command reference.',
    run: () => {
      setAppState({ voiceHelpOpen: true })
      return { ok: true, echo: 'VOICE COMMANDS' }
    },
  },

  // ---- Tier B read-only queries -------------------------------------------------------
  query_unit_etas: {
    klass: 'query',
    description: 'READ-ONLY: report ETAs for units still enroute, from live track data.',
    run: () => {
      const units = Object.values(getAppState().units).filter(
        (u) => (u.status ?? '').toLowerCase() === 'enroute',
      )
      if (!units.length) return { ok: true, echo: 'NO UNITS ENROUTE — ALL ARRIVED', speak: 'No units enroute.' }
      const rows = units
        .map((u) => ({ cs: u.callsign, eta: unitEtaMin(u) ?? 0 }))
        .sort((a, b) => a.eta - b.eta)
        .slice(0, 8)
      const echo = rows.map((r) => `${r.cs} ~${r.eta} MIN`).join('\n')
      const first = rows[0]
      return { ok: true, echo, speak: `${rows.length} enroute. ${first.cs}, about ${first.eta} minutes.` }
    },
  },
  query_par_status: {
    klass: 'query',
    description: 'READ-ONLY: report which units have a completed PAR check and which are outstanding.',
    run: () => {
      const s = getAppState()
      const onScene = Object.values(s.units).filter((u) => isApparatus(u) && isAtBox(u.status))
      const done = onScene.filter((u) => s.parChecks[u.callsign])
      const missing = onScene.filter((u) => !s.parChecks[u.callsign]).map((u) => u.callsign)
      const echo = `PAR ${done.length}/${onScene.length}${missing.length ? `\nOUTSTANDING: ${missing.slice(0, 8).join(', ')}` : ' — COMPLETE'}`
      return { ok: true, echo, speak: `PAR ${done.length} of ${onScene.length}.` }
    },
  },
  query_request_status: {
    klass: 'query',
    description: 'READ-ONLY: summarize open interagency requests and their states.',
    run: () => {
      const reqs = getAppState().interagencyRequests
      if (!reqs.length) return { ok: true, echo: 'NO OPEN REQUESTS', speak: 'No open requests.' }
      const open = reqs.filter((r) => r.state !== 'complete' && r.state !== 'declined')
      const echo = open
        .slice(0, 6)
        .map((r) => `${r.assignedAgency}: ${r.description} — ${r.state.replace('_', ' ').toUpperCase()}`)
        .join('\n')
      return { ok: true, echo: echo || 'ALL REQUESTS CLOSED', speak: `${open.length} open requests.` }
    },
  },
  query_water_supply: {
    klass: 'query',
    description: 'READ-ONLY: report the hydrant picture around the incident building.',
    run: () => {
      const s = getAppState()
      const hyd = s.intel?.hydrants ?? []
      if (!s.incident) return { ok: false, echo: 'NO ACTIVE INCIDENT', tone: 'warn' }
      const near = hyd.filter((h: { lat: number; lon: number }) => distM(h.lat, h.lon, s.incident!.lat, s.incident!.lon) < 150)
      return {
        ok: true,
        echo: `${near.length} HYDRANTS WITHIN 150 M (${hyd.length} MAPPED)`,
        speak: `${near.length} hydrants within one fifty meters.`,
      }
    },
  },

  // ---- DENY LIST — tap-only, voice never executes these -------------------------------
  par_confirm: {
    klass: 'deny',
    description: 'Confirm/complete a PAR entry for a unit. NEVER executable by voice.',
    denyReason: 'PAR confirmation is TAP-ONLY — verify the crew, then tap the unit on the riding list.',
  },
  mayday_ack: {
    klass: 'deny',
    description: 'Acknowledge a mayday. NEVER executable by voice.',
    denyReason: 'MAYDAY acknowledgement is TAP-ONLY — use the mayday banner.',
  },
  riding_modify: {
    klass: 'deny',
    description: 'Add/remove/edit riding list members. NEVER executable by voice.',
    denyReason: 'Riding list changes are TAP-ONLY — edit on the RIDING LIST page.',
  },
}

function setPanelMin(alias: string, minimized: boolean): ExecResult {
  const id = Object.entries(PANEL_IDS).find(([, aliases]) => aliases.includes(alias))?.[0]
  if (!id) return { ok: false, echo: `NO PANEL "${alias.toUpperCase()}"`, tone: 'warn' }
  setPanelMinimized(id, minimized)
  return { ok: true, echo: `${alias.toUpperCase()} ${minimized ? 'MINIMIZED' : 'RESTORED'}` }
}

function normalizeAlarm(word?: string): import('../types').AlarmLevel | null {
  const map: Record<string, import('../types').AlarmLevel> = {
    '2nd': '2nd', second: '2nd',
    '3rd': '3rd', third: '3rd',
    '4th': '4th', fourth: '4th',
    '5th': '5th', fifth: '5th',
  }
  return map[word ?? ''] ?? null
}

function findFeedIncident(spoken?: string): import('../types').FeedIncident | null {
  const feed = getAppState().dispatchFeed
  if (!feed.length) return null
  if (spoken) {
    const num = spoken.replace(/\D/g, '')
    if (num) {
      // Battalion is the only number a feed row actually shows — the feed's
      // internal ids are never spoken anywhere. A numbered miss NEVER falls
      // through to an arbitrary row; the confirm draft names type+address.
      const byBn = feed.find((f) => String(f.battalion) === num)
      if (byBn) return byBn
      return null
    }
  }
  // No number match: the most recent DISPATCHED row is what "respond" means.
  return feed.find((f) => f.status === 'Dispatched') ?? feed[0] ?? null
}

// ---- execution + the confirmation gate -----------------------------------------------

export interface VoiceMeta {
  tier: 'A' | 'B' | 'scenario'
  transcript: string
  t0: number
}

function logVoice(payload: Record<string, unknown>): void {
  try {
    void fetch('/api/timeline', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'voice.command', payload }),
    }).catch(() => {})
  } catch {
    /* test envs without fetch */
  }
}

/** THE single entry point for every voice-initiated action, all tiers.
 *  Class enforcement happens here — not in the grammar, not in the LLM. */
export async function executeIntent(
  intent: string,
  slots: Record<string, string>,
  meta: VoiceMeta,
): Promise<ExecResult> {
  const def = INTENTS[intent]
  const latencyMs = Math.round(performance.now() - meta.t0)
  if (!def) {
    logVoice({ transcript: meta.transcript, intent, tier: meta.tier, latencyMs, outcome: 'unknown_intent' })
    return { ok: false, echo: 'UNKNOWN COMMAND', tone: 'warn' }
  }
  if (def.klass === 'deny') {
    logVoice({ transcript: meta.transcript, intent, tier: meta.tier, latencyMs, outcome: 'denied' })
    return { ok: false, echo: `✕ ${def.denyReason}`, speak: def.denyReason, tone: 'warn' }
  }
  if (def.klass === 'confirm') {
    const draft = def.draft?.(slots) ?? null
    if (!draft) {
      logVoice({ transcript: meta.transcript, intent, tier: meta.tier, latencyMs, outcome: 'draft_failed' })
      return { ok: false, echo: 'COULD NOT DRAFT THAT — SAY IT AGAIN', tone: 'warn' }
    }
    setAppState({ voiceConfirm: { intent, slots, draft } })
    logVoice({ transcript: meta.transcript, intent, tier: meta.tier, latencyMs, outcome: 'drafted' })
    return { ok: true, echo: 'CONFIRM TO EXECUTE', tone: 'warn' }
  }
  const result = await def.run!(slots)
  logVoice({
    transcript: meta.transcript,
    intent,
    tier: meta.tier,
    latencyMs,
    outcome: result.ok ? 'executed' : 'failed',
  })
  return result
}

/** CONFIRM tap (or held-PTT "confirm"): run the gated action. */
export async function confirmPending(): Promise<ExecResult | null> {
  const pending = getAppState().voiceConfirm
  if (!pending) return null
  setAppState({ voiceConfirm: null })
  const def = INTENTS[pending.intent]
  if (!def?.commit) return { ok: false, echo: 'NOTHING TO CONFIRM', tone: 'warn' }
  const result = await def.commit(pending.slots)
  logVoice({ intent: pending.intent, outcome: result.ok ? 'confirmed' : 'confirm_failed', draft: pending.draft })
  return result
}

export function cancelPending(): ExecResult | null {
  const pending = getAppState().voiceConfirm
  if (!pending) return null
  setAppState({ voiceConfirm: null })
  logVoice({ intent: pending.intent, outcome: 'cancelled', draft: pending.draft })
  return { ok: true, echo: 'CANCELLED' }
}

/** Compact manifest of the closed action set — this IS the Tier B tool schema.
 *  Deny-class intents ship too (with their reason) so the model routes
 *  "mark PAR complete" to the refusal path instead of no_match. */
export function intentManifest(): { id: string; description: string; slots: Record<string, { description: string; enum?: string[] }> }[] {
  return Object.entries(INTENTS).map(([id, def]) => ({
    id,
    description: def.klass === 'deny' ? `${def.description} (always refused: ${def.denyReason})` : def.description,
    slots: def.slots ?? {},
  }))
}
