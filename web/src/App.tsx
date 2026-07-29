import { useEffect, useRef, useState } from 'react'
import type { Viewer } from 'cesium'
import { initScene } from './cesium/providers'
import { registerScene, unregisterScene } from './cesium/scene'
import { restoreIncident } from './actions'
import { setAppState, useAppState } from './state/store'
import { TopBar } from './components/TopBar'
import { IncidentCard } from './components/IncidentCard'
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
      <IncidentCard />
      <SiteIntelPanel />
      <div className={`scene-veil${sceneReady ? ' hidden' : ''}`}>
        <div className="mark">WATCHTOWER</div>
        <div className="status">{bootMsg}</div>
      </div>
    </div>
  )
}
