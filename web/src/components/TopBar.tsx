import { useEffect, useRef, useState } from 'react'
import {
  activateInspectedIncident,
  focusFeedIncident,
  loadScenario,
  runDemoScenario,
  setIsolateScale,
  setIsolateView,
  toggleActiveIncidentMode,
  toggleIsolateMode,
  toggleLayer,
  toggleTopDownView,
} from '../actions'
import { setAppState, useAppState } from '../state/store'
import type { FeedIncident, ToggleLayerId } from '../types'
import { SearchBar } from './SearchBar'

// Map overlays that live in the top-bar OVERLAYS dropdown rather than the
// (incident-gated) Site Intel chip row — they're useful with no incident up.
const OVERLAYS: { id: ToggleLayerId; label: string; hint: string }[] = [
  { id: 'battalions', label: 'FDNY Battalions', hint: 'Battalion boundary lines' },
  { id: 'divisions', label: 'FDNY Divisions', hint: 'Division boundary lines' },
  { id: 'lots', label: 'Address grid', hint: 'Tax-lot borders — click inside one to load its address' },
  { id: 'roads', label: 'Road network', hint: 'Yellow overlay of every drivable street, highway, bridge, and ramp' },
  { id: 'tunnels', label: 'Tunnels', hint: 'Major vehicular tunnels — Lincoln, Holland, Queens-Midtown, Hugh L. Carey (commercial access varies per tunnel)' },
  { id: 'poiFirehouses', label: 'All firehouses', hint: 'Every FDNY firehouse citywide (Facilities DB)' },
  { id: 'poiFdny', label: 'FDNY buildings', hint: 'Official FDNY buildings — HQ, offices, training, EMS stations' },
  { id: 'poiPrecincts', label: 'NYPD precincts', hint: 'Precinct station houses citywide' },
  { id: 'poiHospitals', label: 'Major hospitals', hint: 'Hospitals and acute-care hospitals citywide' },
  { id: 'poiNycem', label: 'NYCEM HQ', hint: 'NYC Emergency Management headquarters and offices' },
]

function OverlaysMenu() {
  const { layerToggles } = useAppState()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const anyOn = OVERLAYS.some((o) => layerToggles[o.id])
  return (
    <div className="overlays-wrap" ref={wrapRef}>
      <button
        className={`chip chip-btn${anyOn ? ' active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Map overlays — battalion/division boundaries and the address grid"
      >
        <span className="dot" /> OVERLAYS {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="overlays-menu glass">
          {OVERLAYS.map((o) => (
            <label key={o.id} className="overlay-row" title={o.hint}>
              <input type="checkbox" checked={layerToggles[o.id]} onChange={() => toggleLayer(o.id)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

const MODE_LABEL: Record<string, string> = {
  keyless: 'KEYLESS 3D',
  ion: 'ION TERRAIN',
  google: 'GOOGLE 3D',
}

function feedElapsed(startedAt: string): string {
  const min = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 60_000))
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${min % 60}m`
}

/**
 * Citywide INCIDENTS dropdown (next to the wordmark): the SIMULATED dispatch
 * feed from the FDNY / NYPD / PAPD dispatch centers, broken down by FDNY
 * division → battalion. Clicking a box focuses the whole board on it —
 * stand-up at its location plus the responding assignment.
 */
function IncidentsMenu() {
  const { dispatchFeed, focusedFeedId } = useAppState()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  // Division -> Battalion -> incidents, all numerically ordered.
  const byDivision = new Map<number, Map<number, FeedIncident[]>>()
  for (const fi of dispatchFeed) {
    if (!byDivision.has(fi.division)) byDivision.set(fi.division, new Map())
    const byBn = byDivision.get(fi.division)!
    if (!byBn.has(fi.battalion)) byBn.set(fi.battalion, [])
    byBn.get(fi.battalion)!.push(fi)
  }
  const divisions = [...byDivision.entries()].sort((a, b) => a[0] - b[0])

  const pick = (fi: FeedIncident) => {
    setOpen(false)
    void focusFeedIncident(fi)
  }

  return (
    <div className="incidents-wrap" ref={wrapRef}>
      <button
        className={`chip chip-btn amber${focusedFeedId ? ' active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Citywide incidents from the FDNY / NYPD / PAPD dispatch centers (SIMULATED) — click one to focus the board on it"
      >
        <span className="dot" /> INCIDENTS {dispatchFeed.length} {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="incidents-menu glass">
          <div className="incidents-head">
            SIMULATED CITYWIDE DISPATCH FEED · FDNY / NYPD / PAPD DISPATCH CENTERS
          </div>
          {divisions.length === 0 && <div className="incidents-empty">AWAITING DISPATCH FEED…</div>}
          {divisions.map(([division, byBn]) => (
            <div key={division} className="feed-division">
              <div className="feed-division-head">DIVISION {division}</div>
              {[...byBn.entries()]
                .sort((a, b) => a[0] - b[0])
                .map(([battalion, list]) => (
                  <div key={battalion} className="feed-battalion">
                    <div className="feed-battalion-head">BATTALION {battalion}</div>
                    {list.map((fi) => (
                      <button
                        key={fi.id}
                        className={`feed-row${focusedFeedId === fi.id ? ' focused' : ''}`}
                        onClick={() => pick(fi)}
                        title={`Focus the board on this box — flies to ${fi.address} and puts its responding units on the picture`}
                      >
                        <span className={`feed-src ${fi.source.toLowerCase()}`}>{fi.source}</span>
                        <span className="feed-main">
                          <b>{fi.type}</b>
                          <i>{fi.address} · {fi.borough}</i>
                        </span>
                        <span className="feed-meta">
                          {fi.units} UNITS · {feedElapsed(fi.startedAt)}
                          <em>{focusedFeedId === fi.id ? 'FOCUSED' : fi.status.toUpperCase()}</em>
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Clock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const ss = String(now.getSeconds()).padStart(2, '0')
  return (
    <span className="clock">
      <b>
        {hh}:{mm}:{ss}
      </b>{' '}
      LOCAL
    </span>
  )
}

/** DEMO + DRILL combined — one launcher, two scripted scenarios. */
function ScenariosMenu() {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])
  return (
    <div className="scenarios-wrap" ref={wrapRef}>
      <button className="demo-btn" onClick={() => setOpen((o) => !o)} title="Scripted scenarios — demo and drill">
        ▶ SCENARIOS {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="scenarios-menu glass">
          <button
            className="scenario-item"
            onClick={() => {
              setOpen(false)
              void runDemoScenario()
            }}
          >
            <b>DEMO</b>
            <i>Structural fire, 100 Gold St — full flow, plays unattended</i>
          </button>
          <button
            className="scenario-item drill"
            onClick={() => {
              setOpen(false)
              void loadScenario('pabt-drill')
            }}
          >
            <b>DRILL</b>
            <i>Multi-agency bus fire w/ MCI at the Port Authority Bus Terminal</i>
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * ISOLATE cluster as ONE dropdown: the on/off toggle plus the MODEL / LIVE
 * view and the model's vertical scale — three controls that used to take
 * three top-bar slots.
 */
function IsolateMenu() {
  const { isolateMode, isolateView, isolateScale } = useAppState()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])
  return (
    <div className="isolate-wrap" ref={wrapRef}>
      <button
        className={`chip chip-btn amber${isolateMode ? ' active' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title="Isolate the incident building — clip everything else away; pick MODEL or LIVE view and the model's vertical scale"
      >
        <span className="dot" /> ISOLATE {open ? '▴' : '▾'}
      </button>
      {open && (
        <div className="isolate-menu glass">
          <button
            className={`iso-toggle${isolateMode ? ' on' : ''}`}
            onClick={toggleIsolateMode}
            title="Strip every building, tree, and obstruction except the incident building"
          >
            {isolateMode ? '◉ ISOLATE ON — click to exit' : '◌ ISOLATE OFF — click to isolate the building'}
          </button>
          {isolateMode && (
            <>
              <div className="iso-label">VIEW</div>
              <span className="chip seg">
                <button
                  className={`seg-btn${isolateView === 'model' ? ' on' : ''}`}
                  onClick={() => setIsolateView('model')}
                  title="Clean schematic 3D model from the building's real data — floors, entrances, estimated egress and stairs"
                >
                  MODEL
                </button>
                <button
                  className={`seg-btn${isolateView === 'live' ? ' on' : ''}`}
                  onClick={() => setIsolateView('live')}
                  title="The real (clipped) imagery of the building"
                >
                  LIVE
                </button>
              </span>
              {isolateView === 'model' && (
                <>
                  <div className="iso-label">VERTICAL SCALE</div>
                  <span
                    className="chip seg"
                    title="Stretch the model's floors so unit tracking reads at a glance (real dimensions stay on the header)"
                  >
                    {[1, 1.5, 2].map((k) => (
                      <button
                        key={k}
                        className={`seg-btn${isolateScale === k ? ' on' : ''}`}
                        onClick={() => setIsolateScale(k)}
                      >
                        {k}×
                      </button>
                    ))}
                  </span>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

const LAYER_LABEL: Record<string, string> = {
  footprints: 'FOOTPRINTS',
  pluto: 'PLUTO',
  hydrants: 'HYDRANTS',
  firehouses: 'FIREHOUSES',
  safety: 'DOB DATA',
  persistence: 'PERSISTENCE',
}

export function TopBar() {
  const {
    providerMode,
    layers,
    utilityTab,
    incident,
    inspected,
    activeIncidentMode,
    viewMode,
    nycemView,
  } = useAppState()
  const toggleTab = (tab: 'sitrep' | 'video' | 'bio' | 'floors') =>
    setAppState((s) => ({ utilityTab: s.utilityTab === tab ? null : tab }))
  const down = (Object.keys(layers) as (keyof typeof layers)[]).filter((k) => layers[k] === 'unavailable')
  return (
    <header className="topbar glass">
      <div className="wordmark">
        <span className="sub">Common Operating Picture · FDNY / NYCEM</span>
        <div className="brand-row">
          <span className="name">KEYSTONE</span>
          <IncidentsMenu />
        </div>
      </div>
      <SearchBar />
      <ScenariosMenu />
      <div className="topbar-right">
        {down.map((k) => (
          <span key={k} className="chip warn">
            <span className="dot" /> {LAYER_LABEL[k]} UNAVAILABLE
          </span>
        ))}
        <OverlaysMenu />
        <button
          className="chip chip-btn"
          onClick={() => setAppState((s) => ({ manualsOpen: !s.manualsOpen }))}
          title="Ask the Manuals — cited answers from the local FDNY publications corpus"
        >
          <span className="dot" /> MANUALS
        </button>
        {incident && (
          <button
            className="chip chip-btn amber"
            onClick={() => setAppState((s) => ({ tacticsOpen: !s.tacticsOpen }))}
            title="FFP building-type classification + cited tactics card"
          >
            <span className="dot" /> TACTICS
          </button>
        )}
        <button
          className={`chip chip-btn amber${incident && activeIncidentMode ? ' active' : ''}${!incident && !inspected ? ' disabled' : ''}`}
          aria-disabled={!incident && !inspected}
          onClick={() => {
            // aria-disabled keeps the chip keyboard-reachable (its title is
            // the only arming instruction); activateInspectedIncident is a
            // no-op without an inspected hit, so the inert state is safe.
            if (incident) toggleActiveIncidentMode()
            else void activateInspectedIncident()
          }}
          title={
            incident
              ? 'Refine the fire building; de-emphasize beyond ~4 blocks'
              : inspected
                ? `Stand up the active incident at ${inspected.hit.label} — unlocks ISOLATE + MODEL/LIVE`
                : 'Click a building or address on the map first — then this stands up the incident there'
          }
        >
          <span className="dot" /> ACTIVE INCIDENT
        </button>
        {incident && activeIncidentMode && <IsolateMenu />}
        {incident && (
          <button
            className={`chip chip-btn${nycemView ? ' active' : ''}`}
            onClick={() => setAppState((s) => ({ nycemView: !s.nycemView }))}
            title="Toggle IC tactical view ↔ NYCEM Watch Command coordination view"
          >
            <span className="dot" /> NYCEM
          </button>
        )}
        <button
          className={`chip chip-btn${utilityTab === 'sitrep' ? ' active' : ''}`}
          onClick={() => toggleTab('sitrep')}
          title="Live situation summary"
        >
          <span className="dot" /> SITREP
        </button>
        <button
          className={`chip chip-btn${utilityTab === 'video' ? ' active' : ''}`}
          onClick={() => toggleTab('video')}
          title="Drone / helicopter / body-cam feeds"
        >
          <span className="dot" /> VIDEO
        </button>
        <button
          className={`chip chip-btn${utilityTab === 'bio' ? ' active' : ''}`}
          onClick={() => toggleTab('bio')}
          title="Member biometrics + rotation advisories"
        >
          <span className="dot" /> BIO
        </button>
        <button
          className={`chip chip-btn${utilityTab === 'floors' ? ' active' : ''}`}
          onClick={() => toggleTab('floors')}
          title="Floor-by-floor member accountability"
        >
          <span className="dot" /> FLOORS
        </button>
        {providerMode && (
          <button
            className={`chip chip-btn${viewMode === 'topdown' ? ' active' : ''}`}
            onClick={() => void toggleTopDownView()}
            title="Toggle the camera between the tactical 3D view and a straight-down satellite view"
          >
            <span className="dot" /> {viewMode === 'topdown' ? 'TOP-DOWN' : MODE_LABEL[providerMode]}
          </button>
        )}
        <Clock />
      </div>
    </header>
  )
}
