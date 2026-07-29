import { useEffect, useRef, useState } from 'react'
import type { Viewer } from 'cesium'
import { initScene } from './cesium/providers'
import { registerScene, unregisterScene } from './cesium/scene'
import { restoreIncident } from './actions'
import { setAppState, useAppState } from './state/store'
import { connectWs } from './ws'
import { TopBar } from './components/TopBar'
import { BodycamWall } from './components/BodycamWall'
import { DrawToolbar } from './components/DrawToolbar'
import { DronePanel } from './components/DronePanel'
import { IncidentCard } from './components/IncidentCard'
import { RosterPanel } from './components/RosterPanel'
import { SiteIntelPanel } from './components/SiteIntelPanel'

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
      <div className="left-dock">
        <IncidentCard />
        <RosterPanel />
      </div>
      <DrawToolbar />
      <SiteIntelPanel />
      <BodycamWall />
      <DronePanel />
      <div className={`scene-veil${sceneReady ? ' hidden' : ''}`}>
        <div className="mark">WATCHTOWER</div>
        <div className="status">{bootMsg}</div>
      </div>
    </div>
  )
}
