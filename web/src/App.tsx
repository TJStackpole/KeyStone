import { useEffect, useRef, useState } from 'react'
import type { Viewer } from 'cesium'
import { initScene } from './cesium/providers'
import { registerScene, unregisterScene } from './cesium/scene'
import { exitGround, restoreIncident } from './actions'
import { setAppState, useAppState } from './state/store'
import { connectWs } from './ws'
import { TopBar } from './components/TopBar'
import { CommandStrip } from './components/CommandStrip'
import { CommsPanel } from './components/CommsPanel'
import { UtilityDock } from './components/UtilityDock'
import { DrawToolbar } from './components/DrawToolbar'
import { IncidentCard } from './components/IncidentCard'
import { RosterPanel } from './components/RosterPanel'
import { SiteIntelPanel } from './components/SiteIntelPanel'

/** Floating escape hatch while the camera is at street level. */
function GroundViewExit() {
  const { groundViewActive } = useAppState()
  if (!groundViewActive) return null
  return (
    <button className="ground-exit glass" onClick={exitGround} title="Return to the tactical camera (Esc)">
      ⏏ EXIT GROUND VIEW
    </button>
  )
}

export default function App() {
  const globeRef = useRef<HTMLDivElement>(null)
  const [bootMsg, setBootMsg] = useState('Initializing 3D scene')
  const { sceneReady } = useAppState()

  useEffect(() => {
    let disposed = false
    let viewer: Viewer | undefined
    if (!globeRef.current) return

    initScene(globeRef.current)
      .then((handle) => {
        if (disposed) {
          handle.viewer.destroy()
          return
        }
        viewer = handle.viewer
        registerScene(handle)
        setAppState({ sceneReady: true, providerMode: handle.mode })
        connectWs()
        void restoreIncident()
      })
      .catch((err) => {
        console.error('[scene] init failed:', err)
        setBootMsg('Scene init failed — see console')
      })

    return () => {
      disposed = true
      unregisterScene()
      viewer?.destroy()
    }
  }, [])

  return (
    <div className="app">
      <div ref={globeRef} className="globe" />
      <TopBar />
      <CommandStrip />
      <div className="left-dock">
        <IncidentCard />
        <RosterPanel />
      </div>
      <DrawToolbar />
      <SiteIntelPanel />
      <UtilityDock />
      <CommsPanel />
      <GroundViewExit />
      <div className={`scene-veil${sceneReady ? ' hidden' : ''}`}>
        <div className="mark">KEYSTONE</div>
        <div className="status">{bootMsg}</div>
      </div>
    </div>
  )
}
