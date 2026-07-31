import { useEffect, useRef, useState } from 'react'
import {
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
import type { ToggleLayerId } from '../types'
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
    takConnected,
    utilityTab,
    incident,
    activeIncidentMode,
    isolateMode,
    isolateView,
    isolateScale,
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
        <span className="name">KEYSTONE</span>
      </div>
      <SearchBar />
      <button className="demo-btn" onClick={() => void runDemoScenario()} title="Demo scenario: structural fire, 100 Gold St — full flow unattended">
        ▶ DEMO
      </button>
      <button
        className="demo-btn drill"
        onClick={() => void loadScenario('pabt-drill')}
        title="Scripted multi-agency drill: bus fire w/ MCI at the Port Authority Bus Terminal — plays itself"
      >
        ▶ DRILL
      </button>
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
        {takConnected === true && (
          <button
            className="chip chip-btn"
            onClick={() => setAppState((s) => ({ chatOpen: !s.chatOpen }))}
            title="TAK link is up — click for GeoChat with every unit on the server"
          >
            <span className="dot" /> TAK LINK
          </button>
        )}
        {takConnected === false && (
          <span className="chip warn">
            <span className="dot" /> TAK OFFLINE
          </span>
        )}
        {incident && (
          <button
            className={`chip chip-btn amber${activeIncidentMode ? ' active' : ''}`}
            onClick={toggleActiveIncidentMode}
            title="Refine the fire building; de-emphasize beyond ~4 blocks"
          >
            <span className="dot" /> ACTIVE INCIDENT
          </button>
        )}
        {incident && activeIncidentMode && (
          <button
            className={`chip chip-btn amber${isolateMode ? ' active' : ''}`}
            onClick={toggleIsolateMode}
            title="Strip every building, tree, and obstruction except the incident building"
          >
            <span className="dot" /> ISOLATE
          </button>
        )}
        {incident && activeIncidentMode && isolateMode && (
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
        )}
        {incident && activeIncidentMode && isolateMode && isolateView === 'model' && (
          <span className="chip seg" title="Vertical scale — stretch the model's floors so unit tracking reads at a glance (real dimensions stay on the header)">
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
        )}
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
