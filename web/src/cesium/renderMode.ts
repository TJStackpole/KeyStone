import type { Viewer } from 'cesium'
import { getAppState, subscribeStore } from '../state/store'

// ---------------------------------------------------------------------------
// Idle render throttle. Without requestRenderMode Cesium re-renders the full
// photorealistic scene at display refresh (measured 120 fps) around the
// clock — a KeyStone wall display showing a static map burns a GPU core for
// nothing. This controller flips the scene into requestRenderMode whenever
// the picture is static (no incident, no units, no drill, no citywide view,
// no replay, no street-level camera) and back to continuous rendering the
// moment anything live appears.
//
// While idle, a 1 Hz heartbeat requestRender() guarantees that anything that
// slips past Cesium's own rrm triggers (camera, tile loads) — an overlay
// toggle, a provider upgrade — paints within a second. Continuous mode is
// authoritative during operations, so animated materials (pulsing enroute
// markers) are never throttled when they exist.
// ---------------------------------------------------------------------------

function pictureIsLive(): boolean {
  const s = getAppState()
  return (
    !s.sceneReady || // keep rendering freely through boot/tile warmup
    !!s.incident ||
    Object.keys(s.units).length > 0 ||
    !!s.scenario?.loaded ||
    s.watchCommand ||
    s.replay.active ||
    s.groundViewActive ||
    s.inspectedModelOn
  )
}

export function attachRenderModeController(viewer: Viewer): () => void {
  // shouldAnimate keeps the clock ticking; without this ceiling the advancing
  // sim time itself forces a render every frame even in requestRenderMode.
  viewer.scene.maximumRenderTimeChange = Infinity

  const apply = () => {
    if (viewer.isDestroyed()) return
    const idle = !pictureIsLive()
    if (viewer.scene.requestRenderMode !== idle) {
      viewer.scene.requestRenderMode = idle
      viewer.scene.requestRender() // paint the transition itself
    }
  }

  const unsubscribe = subscribeStore(apply)
  const heartbeat = setInterval(() => {
    if (!viewer.isDestroyed() && viewer.scene.requestRenderMode) viewer.scene.requestRender()
  }, 1000)
  apply()

  return () => {
    unsubscribe()
    clearInterval(heartbeat)
  }
}
