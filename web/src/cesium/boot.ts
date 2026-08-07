// ---------------------------------------------------------------------------
// Scene boot — the dynamic-import boundary of the city3d chunk. App.tsx
// (boot bundle) awaits ensureCesiumScript() and then imports THIS module,
// which drags in scene construction, every layer class, providers, and the
// rest of the 3D stack — none of which ship in the boot bundle.
// ---------------------------------------------------------------------------

import {
  ensureTunnels,
  reconcileProviderUpgrade,
  refreshLots,
  refreshRoads,
  refreshStreetLabels,
  restoreIncident,
} from '../actions'
import { setAppState } from '../state/store'
import { applyOverlayLod } from './overlayLod'
import { initScene } from './providers'
import { registerScene, unregisterScene } from './scene'

/** Build the Cesium scene and wire the app to it. Returns a disposer. */
export async function bootScene(globeEl: HTMLElement): Promise<() => void> {
  performance.mark('keystone:init-scene-start')
  let disposed = false
  const handle = await initScene(globeEl, () => {
    // Background provider upgrade landed (or fell back to keyless) —
    // refresh the chip and re-bake globe-window height samples.
    if (!disposed) reconcileProviderUpgrade()
  })
  if (disposed) {
    handle.viewer.destroy()
    return () => {}
  }
  registerScene(handle)
  performance.mark('keystone:scene-ready')
  setAppState({ sceneReady: true, providerMode: handle.mode })
  // The incident restored before the engine existed — repeat the pass so
  // the 3D side (camera, footprints, focus ring) catches up.
  void restoreIncident()
  // Camera-following overlays: lots, the yellow road network, and street
  // labels refresh whenever a pan/zoom settles low enough (each gates on
  // its own toggle + height + movement).
  handle.viewer.camera.moveEnd.addEventListener(() => {
    applyOverlayLod() // glows reveal/hide with camera distance
    void refreshLots()
    void refreshRoads()
    void refreshStreetLabels()
  })
  // The four major vehicular tunnels are citywide + static — load once.
  ensureTunnels()
  return () => {
    disposed = true
    unregisterScene()
    handle.viewer.destroy()
  }
}
