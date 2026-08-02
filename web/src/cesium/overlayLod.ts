import { getAppState } from '../state/store'
import { getLotLayer, getRoadLayer, getScene } from './scene'

// ---------------------------------------------------------------------------
// Distance-gated overlay glows. The cyan lot lines, yellow road network and
// amber tunnel traces are close-range study aids — painted citywide from a
// command altitude they read as noise over the picture. Each keeps its
// toggle chip as the operator's stored intent, but only PAINTS once the
// camera is near enough for the glow to mean something. Click-to-inspect is
// untouched: lot borders stay hit-testable while hidden, and the inspect
// highlight is a separate layer.
// ---------------------------------------------------------------------------

export const OVERLAY_LOD_MAX_M = {
  lots: 1500, // cyan parcel lines — block-level study range
  roads: 2200, // yellow road network
  tunnels: 4500, // amber tunnel traces are long linear features; earlier reveal
} as const

export type OverlayLodKind = keyof typeof OVERLAY_LOD_MAX_M

/** Camera height above the incident's street level (falls back to ellipsoid
 *  height — the ~30 m google-mode geoid offset is noise at these ranges). */
function cameraHeightM(): number {
  const scene = getScene()
  if (!scene) return Number.POSITIVE_INFINITY
  return scene.viewer.camera.positionCartographic.height - (getAppState().floorRef?.z0 ?? 0)
}

export function overlayLodAllows(kind: OverlayLodKind): boolean {
  return cameraHeightM() < OVERLAY_LOD_MAX_M[kind]
}

/**
 * Re-gate the three glow layers against the current camera height. Runs on
 * every moveEnd (zooming closer reveals, pulling back hides) and after any
 * refresh re-render. ISOLATE parks all overlays wholesale — never repaint
 * over that; setOverlaysParked(false) re-applies the gate on exit.
 */
export function applyOverlayLod(): void {
  const s = getAppState()
  if (!s.sceneReady || s.isolateMode) return
  const t = s.layerToggles
  getLotLayer()?.setVisible(t.lots && overlayLodAllows('lots'))
  getRoadLayer()?.setRoadsVisible(t.roads && overlayLodAllows('roads'))
  getRoadLayer()?.setTunnelsVisible(t.tunnels && overlayLodAllows('tunnels'))
}
