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
  persistence: 'PERSISTENCE',
}

export function TopBar() {
  const { providerMode, layers, takConnected, bodycamOpen } = useAppState()
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
          className={`chip chip-btn${bodycamOpen ? ' active' : ''}`}
          onClick={() => setAppState((s) => ({ bodycamOpen: !s.bodycamOpen }))}
          title="Toggle body-cam wall"
        >
          <span className="dot" /> BODYCAMS
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
