import * as Cesium from 'cesium'
import type { ProviderMode } from '../types'

export interface SceneHandle {
  viewer: Cesium.Viewer
  mode: ProviderMode
  /**
   * Keyless mode has no building tileset, so we extrude NYC Open Data footprints
   * ourselves. Ion / Google modes ship their own 3D buildings — extruding on top
   * of those would z-fight, so we only draw the target-highlight outline there.
   */
  extrudeFootprints: boolean
}

/**
 * Provider selection per CLAUDE.md constraint 2 — one function, no code edits to swap:
 *   GOOGLE_MAPS_API_KEY present  -> Google Photorealistic 3D Tiles
 *   CESIUM_ION_TOKEN present     -> Cesium World Terrain + OSM Buildings
 *   neither (default)            -> keyless: OSM imagery + ellipsoid terrain,
 *                                   buildings extruded from NYC Building Footprints
 */
export async function initScene(container: HTMLElement): Promise<SceneHandle> {
  const googleKey = (import.meta.env.GOOGLE_MAPS_API_KEY ?? '').trim()
  const ionToken = (import.meta.env.CESIUM_ION_TOKEN ?? '').trim()
  const mode: ProviderMode = googleKey ? 'google' : ionToken ? 'ion' : 'keyless'

  // Never let Cesium fall back to its bundled demo ion token — keyless means keyless.
  Cesium.Ion.defaultAccessToken = mode === 'ion' ? ionToken : ''

  const osmLayer = new Cesium.ImageryLayer(
    new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
  )

  const viewer = new Cesium.Viewer(container, {
    baseLayer: osmLayer,
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    animation: false,
    timeline: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    baseLayerPicker: false,
    navigationHelpButton: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    msaaSamples: 4,
  })

  // Tactical console mood: kill the daylight sim, dim the basemap toward the theme.
  const scene = viewer.scene
  scene.backgroundColor = Cesium.Color.fromCssColorString('#0a0e14')
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#0d1420')
  scene.globe.enableLighting = false
  if (scene.skyBox) scene.skyBox.show = false
  if (scene.sun) scene.sun.show = false
  if (scene.moon) scene.moon.show = false
  if (scene.skyAtmosphere) scene.skyAtmosphere.show = false
  osmLayer.brightness = 0.55
  osmLayer.contrast = 1.2
  osmLayer.saturation = 0.25
  osmLayer.gamma = 0.9

  // Double-click zoom-to-entity fights the tactical camera; remove it.
  viewer.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK)

  // Background/embedded contexts can suspend requestAnimationFrame, which freezes
  // Cesium's render loop (and with it imagery/tile streaming). Watchdog: if no
  // frame has rendered since the last tick, drive a frame manually and pump the
  // request scheduler. When rAF runs normally this no-ops. Matters for wall
  // displays, embedded panes, and backgrounded tabs.
  let lastFrame = -1
  const keepAlive = setInterval(() => {
    if (viewer.isDestroyed()) {
      clearInterval(keepAlive)
      return
    }
    if (viewer.scene.frameState.frameNumber === lastFrame) {
      try {
        viewer.render()
        Cesium.RequestScheduler.update()
      } catch (err) {
        console.error('[providers] watchdog render tick failed:', err)
      }
    }
    lastFrame = viewer.scene.frameState.frameNumber
  }, 400)

  if (mode === 'ion') {
    try {
      viewer.terrainProvider = await Cesium.createWorldTerrainAsync()
      scene.primitives.add(await Cesium.createOsmBuildingsAsync())
    } catch (err) {
      console.error('[providers] ion upgrade failed, staying keyless:', err)
      return { viewer, mode: 'keyless', extrudeFootprints: true }
    }
  } else if (mode === 'google') {
    try {
      const tileset = await Cesium.Cesium3DTileset.fromUrl(
        `https://tile.googleapis.com/v1/3dtiles/root.json?key=${googleKey}`,
        { showCreditsOnScreen: true },
      )
      scene.primitives.add(tileset)
    } catch (err) {
      console.error('[providers] Google 3D Tiles failed, staying keyless:', err)
      return { viewer, mode: 'keyless', extrudeFootprints: true }
    }
  }

  // Establishing shot: over the harbor looking north at Lower Manhattan.
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-74.0085, 40.6875, 2800),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-35), roll: 0 },
  })

  return { viewer, mode, extrudeFootprints: mode === 'keyless' }
}

/** Oblique tactical fly-to: ~45° pitch from ~400 m, camera standing off south of the target. */
export function flyToTactical(viewer: Cesium.Viewer, lat: number, lon: number, durationS = 3): void {
  const altitude = 400
  // Stand off so a -45° look ray from `altitude` lands on the target.
  const standoffDeg = altitude / 111_320
  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(lon, lat - standoffDeg, altitude),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-45), roll: 0 },
    duration: durationS,
  })
}
