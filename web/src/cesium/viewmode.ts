import * as Cesium from 'cesium'
import type { SceneHandle } from './providers'

// ---------------------------------------------------------------------------
// View modes beyond the tactical camera:
//  - TOP-DOWN: straight-down "satellite" look. Google/ion modes already show
//    real imagery; keyless overlays Esri World Imagery (keyless service) so
//    the top-down view is true satellite there too.
//  - GROUND: eye-height view from any clicked spot, looking at the incident.
// Both remember the camera they replaced and restore it on exit.
// ---------------------------------------------------------------------------

interface SavedCamera {
  destination: Cesium.Cartesian3
  heading: number
  pitch: number
}

function captureCamera(viewer: Cesium.Viewer): SavedCamera {
  return {
    destination: viewer.camera.position.clone(),
    heading: viewer.camera.heading,
    pitch: viewer.camera.pitch,
  }
}

function restoreCamera(viewer: Cesium.Viewer, cam: SavedCamera, durationS: number): void {
  viewer.camera.flyTo({
    destination: cam.destination,
    orientation: { heading: cam.heading, pitch: cam.pitch, roll: 0 },
    duration: durationS,
  })
}

// ------------------------------- top-down ----------------------------------

let esriLayer: Cesium.ImageryLayer | null = null
let savedTopDown: SavedCamera | null = null

export async function setTopDown(scene: SceneHandle, on: boolean, focus?: { lat: number; lon: number }): Promise<void> {
  const viewer = scene.viewer
  if (on) {
    if (!savedTopDown) savedTopDown = captureCamera(viewer)
    if (scene.mode === 'keyless' && !esriLayer) {
      try {
        const provider = await Cesium.ArcGisMapServerImageryProvider.fromUrl(
          'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
        )
        esriLayer = viewer.imageryLayers.addImageryProvider(provider)
      } catch (err) {
        console.warn('[viewmode] satellite imagery unavailable, keeping OSM basemap:', err)
      }
    }
    const pos = viewer.camera.positionCartographic
    const center = focus ?? {
      lat: Cesium.Math.toDegrees(pos.latitude),
      lon: Cesium.Math.toDegrees(pos.longitude),
    }
    // Keep roughly the operator's scale, inside a sane top-down band.
    const height = Math.min(Math.max(pos.height, 500), 4500)
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(center.lon, center.lat, height),
      orientation: { heading: viewer.camera.heading, pitch: Cesium.Math.toRadians(-90), roll: 0 },
      duration: 1.2,
    })
  } else {
    if (esriLayer) {
      viewer.imageryLayers.remove(esriLayer) // remove() destroys the layer
      esriLayer = null
    }
    if (savedTopDown) {
      restoreCamera(viewer, savedTopDown, 1.2)
      savedTopDown = null
    }
  }
}

// ------------------------------ ground view ---------------------------------

let savedGround: { cam: SavedCamera; minZoom: number; collision: boolean } | null = null

/** Initial bearing from A to B, degrees true. */
function bearingDeg(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const φ1 = (a.lat * Math.PI) / 180
  const φ2 = (b.lat * Math.PI) / 180
  const Δλ = ((b.lon - a.lon) * Math.PI) / 180
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

export function enterGroundView(
  viewer: Cesium.Viewer,
  pos: { lat: number; lon: number; hae: number },
  lookAt?: { lat: number; lon: number },
): void {
  const ctl = viewer.scene.screenSpaceCameraController
  if (!savedGround) {
    savedGround = {
      cam: captureCamera(viewer),
      minZoom: ctl.minimumZoomDistance,
      collision: ctl.enableCollisionDetection,
    }
  }
  // At eye height the ellipsoid "ground" sits above the real street on
  // photorealistic tiles — collision detection would shove the camera up.
  ctl.minimumZoomDistance = 2
  ctl.enableCollisionDetection = false
  const heading = lookAt ? Cesium.Math.toRadians(bearingDeg(pos, lookAt)) : viewer.camera.heading
  // setView, not flyTo: NYC streets sit BELOW the ellipsoid on photorealistic
  // tiles (geoid offset) and camera flights refuse to descend past it — the
  // tween completes without moving. An instant cut also reads fine here.
  // Trust the pick when it's inside NYC's plausible surface band (streets
  // ≈ -35 m ellipsoidal, roofs up to 1WTC). Out-of-band picks come from
  // half-loaded tiles — fall back to a scene sample, then a typical street.
  // (Don't blend sample into good picks: it can return the ellipsoid globe,
  // which floats ~33 m above photorealistic-tile streets.)
  let hae = Number.isFinite(pos.hae) ? pos.hae : NaN
  if (!(hae >= -36 && hae <= 450)) {
    const surface = viewer.scene.sampleHeight?.(Cesium.Cartographic.fromDegrees(pos.lon, pos.lat))
    hae = surface !== undefined && Number.isFinite(surface) ? surface : -30
  }
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(pos.lon, pos.lat, hae + 2.2),
    orientation: { heading, pitch: Cesium.Math.toRadians(4), roll: 0 },
  })
}

export function exitGroundView(viewer: Cesium.Viewer): void {
  if (!savedGround) return
  const ctl = viewer.scene.screenSpaceCameraController
  ctl.minimumZoomDistance = savedGround.minZoom
  ctl.enableCollisionDetection = savedGround.collision
  restoreCamera(viewer, savedGround.cam, 1.4)
  savedGround = null
}

export function groundViewSaved(): boolean {
  return savedGround !== null
}
