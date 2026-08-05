import { TacticalMap2D } from './map2d/TacticalMap2D'
import { useEffect, useRef, useState } from 'react'
import type { Viewer } from 'cesium'
import { initScene } from './cesium/providers'
import { registerScene, unregisterScene } from './cesium/scene'
import {
  ensureTunnels,
  exitGround,
  reconcileProviderUpgrade,
  refreshLots,
  refreshRoads,
  refreshStreetLabels,
  restoreIncident,
  setGroundHeightFt,
} from './actions'
import { setAppState, useAppSlice, useAppState } from './state/store'
import { connectWs } from './ws'
import { TopBar } from './components/TopBar'
import { CommsPanel } from './components/CommsPanel'
import { UtilityDock } from './components/UtilityDock'
import { DrawToolbar } from './components/DrawToolbar'
import { IncidentCard } from './components/IncidentCard'
import { RosterPanel } from './components/RosterPanel'
import { FloorGauge } from './components/FloorGauge'
import { SiteIntelPanel } from './components/SiteIntelPanel'
import { ScenarioBar } from './components/ScenarioBar'
import { MaydayAlert } from './components/MaydayAlert'
import { AarPanel } from './components/AarPanel'
import { StreetViewPanel } from './components/StreetViewPanel'
import { Compass } from './components/Compass'
import { ManualsPanel } from './components/ManualsPanel'
import { TacticsPanel } from './components/TacticsPanel'
import { WindAdvisory } from './components/WindAdvisory'
import { TakChatPanel, TakLinkButton } from './components/TakChatPanel'
import { MyAgencyRequestsPanel } from './components/MyAgencyRequestsPanel'
import { ProfileWatermark } from './components/ProfileWatermark'
import { NoticeChip } from './components/NoticeChip'
import { useCapability } from './profiles/manifest'
import { applyOverlayLod } from './cesium/overlayLod'
import { FeedHealthPanel } from './components/FeedHealthPanel'
import { attachLayoutSwipe } from './lib/layouts'
import { PracticeTour } from './components/PracticeTour'
import { ResponsePacket } from './components/ResponsePacket'
import { CommandBoardPage } from './components/CommandBoardPage'
import { RidingListPage } from './components/RidingListPage'
import { DashboardTabs } from './components/DashboardTabs'
import { CommandStrip } from './components/CommandStrip'
import { OpsBanner } from './components/OpsBanner'
import { DecisionLogPage } from './components/DecisionLogPage'
import { ResourceLedgerPage } from './components/ResourceLedgerPage'

/**
 * Prompt 12 — manifest gate: children render only when the active profile
 * has the capability. App stays store-subscription-free; each Gate
 * subscribes to the profile slice only.
 */
function Gate({ cap, children }: { cap: string; children: React.ReactNode }) {
  const on = useCapability(cap)
  return on ? <>{children}</> : null
}

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

/**
 * Eye-height scale for ground view (0–50 ft AGL): shown while the GND tool is
 * armed (sets the next drop) and while down (raises/lowers the camera live,
 * like an aerial-platform mast).
 */
function GroundHeightControl() {
  const { drawTool, groundViewActive, groundViewFt } = useAppState()
  if (drawTool !== 'ground' && !groundViewActive) return null
  return (
    <div className="ground-height glass">
      <label htmlFor="gnd-ft">HEIGHT AGL</label>
      <input
        id="gnd-ft"
        type="range"
        min={0}
        max={50}
        step={1}
        value={groundViewFt}
        onChange={(e) => setGroundHeightFt(Number(e.target.value))}
      />
      <b>{groundViewFt} FT</b>
    </div>
  )
}

/**
 * Boot veil in its OWN component: App itself must not subscribe to the store
 * — with ~40 units updating every 1-2 s, an App-level useAppState re-rendered
 * (reconciled) the entire panel tree on every write. Hoisted here, App
 * renders once and each panel subscribes independently.
 */
function BootVeil({ msg }: { msg: string }) {
  const { sceneReady, mapMode, profile, map2dReady } = useAppState()
  // Prompt 14: on the FDNY 2D view the veil lifts when the 2D MAP is ready —
  // not on first render (bare void), not on Cesium (fake slow boot).
  const lifted = sceneReady || (profile === 'fdny' && mapMode === '2d' && map2dReady)
  return (
    <div className={`scene-veil${lifted ? ' hidden' : ''}`}>
      <div className="mark">KEYSTONE</div>
      <div className="status">{msg}</div>
    </div>
  )
}

export default function App() {
  const globeRef = useRef<HTMLDivElement>(null)
  const [bootMsg, setBootMsg] = useState('Initializing 3D scene')
  const { gloveMode, replayActive } = useAppSlice((s) => ({ gloveMode: s.gloveMode, replayActive: s.replay.active }))

  useEffect(() => {
    let disposed = false
    let detachSwipe: (() => void) | null = null
    let viewer: Viewer | undefined
    if (!globeRef.current) return

    performance.mark('keystone:init-scene-start')
    initScene(globeRef.current, () => {
      // Background provider upgrade landed (or fell back to keyless) —
      // refresh the chip and re-bake globe-window height samples.
      if (!disposed) reconcileProviderUpgrade()
    })
      .then((handle) => {
        if (disposed) {
          handle.viewer.destroy()
          return
        }
        viewer = handle.viewer
        registerScene(handle)
        performance.mark('keystone:scene-ready')
        setAppState({ sceneReady: true, providerMode: handle.mode })
        connectWs()
        void restoreIncident()
        // Camera-following overlays: lots, the yellow road network, and
        // street labels refresh whenever a pan/zoom settles low enough
        // (each gates on its own toggle + height + movement).
        handle.viewer.camera.moveEnd.addEventListener(() => {
          applyOverlayLod() // glows reveal/hide with camera distance
          void refreshLots()
          void refreshRoads()
          void refreshStreetLabels()
        })
        // The four major vehicular tunnels are citywide + static — load once.
        ensureTunnels()
        // Tablet/ATAK: edge swipes flip role layouts like dashboard pages.
        detachSwipe = attachLayoutSwipe()
      })
      .catch((err) => {
        console.error('[scene] init failed:', err)
        setBootMsg('Scene init failed — see console')
      })

    return () => {
      disposed = true
      detachSwipe?.()
      unregisterScene()
      viewer?.destroy()
    }
  }, [])

  return (
    <div className={`app${gloveMode ? ' glove' : ''}`}>
      <div ref={globeRef} className="globe" />
      <TopBar />
      <div className="left-dock">
        <IncidentCard />
        <RosterPanel />
      </div>
      <DrawToolbar />
      <SiteIntelPanel />
      <FloorGauge />
      <UtilityDock />
      <CommsPanel />
      <GroundViewExit />
      <GroundHeightControl />
      <ScenarioBar />
      <FeedHealthPanel />
      <PracticeTour />
      <TacticalMap2D />
      <OpsBanner />
      <CommandBoardPage />
      <RidingListPage />
      <DecisionLogPage />
      <ResourceLedgerPage />
      <DashboardTabs />
      {replayActive && <CommandStrip />}
      <ResponsePacket />
      <MaydayAlert />
      <Gate cap="aar.drill-debrief">
        <AarPanel />
      </Gate>
      <StreetViewPanel />
      <TakChatPanel />
      <TakLinkButton />
      <Gate cap="doctrine.manuals">
        <ManualsPanel />
      </Gate>
      <Gate cap="tactics.engine">
        <TacticsPanel />
      </Gate>
      <MyAgencyRequestsPanel />
      <ProfileWatermark />
      <NoticeChip />
      <WindAdvisory />
      <Compass />
      <BootVeil msg={bootMsg} />
    </div>
  )
}
