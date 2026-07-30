import { useEffect, useState } from 'react'
import { runDemoScenario } from '../actions'
import { setAppState, useAppState } from '../state/store'
import { SearchBar } from './SearchBar'

const MODE_LABEL: Record<string, string> = {
  keyless: 'KEYLESS 3D',
  ion: 'ION TERRAIN',
  google: 'GOOGLE 3D TILES',
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
  const { providerMode, layers, takConnected, utilityTab } = useAppState()
  const toggleTab = (tab: 'sitrep' | 'video' | 'bio' | 'floors') =>
    setAppState((s) => ({ utilityTab: s.utilityTab === tab ? null : tab }))
  const down = (Object.keys(layers) as (keyof typeof layers)[]).filter((k) => layers[k] === 'unavailable')
  return (
    <header className="topbar glass">
      <div className="wordmark">
        <span className="name">WATCHTOWER</span>
        <span className="sub">Common Operating Picture · FDNY / NYCEM</span>
      </div>
      <SearchBar />
      <button className="demo-btn" onClick={() => void runDemoScenario()} title="Structural fire, 100 Gold St — full flow unattended">
        ▶ DEMO: 100 GOLD ST
      </button>
      <div className="topbar-right">
        {down.map((k) => (
          <span key={k} className="chip warn">
            <span className="dot" /> {LAYER_LABEL[k]} UNAVAILABLE
          </span>
        ))}
        {takConnected === true && (
          <span className="chip">
            <span className="dot" /> TAK LINK
          </span>
        )}
        {takConnected === false && (
          <span className="chip warn">
            <span className="dot" /> TAK OFFLINE
          </span>
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
          <span className="chip">
            <span className="dot" /> {MODE_LABEL[providerMode]}
          </span>
        )}
        <Clock />
      </div>
    </header>
  )
}
