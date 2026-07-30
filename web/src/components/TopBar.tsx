import { useEffect, useState } from 'react'
import {
  loadScenario,
  runDemoScenario,
  toggleActiveIncidentMode,
  toggleIsolateMode,
  toggleTopDownView,
} from '../actions'
import { setAppState, useAppState } from '../state/store'
import { SearchBar } from './SearchBar'

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
