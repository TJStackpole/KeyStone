import * as Cesium from 'cesium'
import { getAppState } from '../state/store'
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
  /** The 3D-buildings tileset when one exists (Google / OSM Buildings). */
  buildingTileset?: Cesium.Cesium3DTileset
}

/**
 * Operating envelope: NYC city limits (lon −74.26..−73.70, lat 40.48..40.92)
 * padded by 50 miles — the map is cropped to this. The camera can't leave it,
 * and the globe neither renders nor downloads imagery outside it.
 */
export const OPS_AREA = Cesium.Rectangle.fromDegrees(-75.22, 39.74, -72.74, 41.65)

/**
 * Tile cache for the 3D-buildings tileset (google/ion). One constant so the
 * isolate boost's restore path can't drift from the creation-time tuning.
 */
export const TILE_CACHE_BYTES = 768 * 1024 * 1024

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
    // Unit markers are SampledPositionProperties evaluated at clock time —
    // without an animating clock every marker renders pinned at its first
    // sample forever while trails/roster show the true positions.
    shouldAnimate: true,
  })

  // Track the wall clock exactly — unit samples are stamped with real time,
  // so a clock that merely ticks from page-load renders every marker a few
  // seconds in the past. (Setter also forces shouldAnimate/multiplier.)
  viewer.clock.clockStep = Cesium.ClockStep.SYSTEM_CLOCK
  // The Viewer resets clock.canAnimate every frame to "are all data sources
  // done building?" — meant for buffered CZML playback. Our constantly-growing
  // trails/labels keep that false much of the time, which would FREEZE unit
  // interpolation. We play no time-dynamic data; pin the gate open.
  Object.defineProperty(viewer.clock, 'canAnimate', { get: () => true, set: () => undefined })

  // Tactical console mood: kill the daylight sim, dim the basemap toward the theme.
  const scene = viewer.scene
  scene.backgroundColor = Cesium.Color.fromCssColorString('#0a0e14')
  scene.globe.baseColor = Cesium.Color.fromCssColorString('#0d1420')
  scene.globe.enableLighting = false
  // Crop the world to the ops envelope — imagery tiles beyond NYC+50mi are
  // never requested, so there's simply less map to download.
  scene.globe.cartographicLimitRectangle = OPS_AREA
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

  // Operator-friendly camera mapping: left-drag pans, wheel/pinch zooms, and
  // RIGHT-DRAG ROTATES/TILTS the map (Cesium's default right-drag zoom is
  // redundant with the wheel and leaves no obvious rotate on trackpads).
  const scc = scene.screenSpaceCameraController
  scc.tiltEventTypes = [
    Cesium.CameraEventType.RIGHT_DRAG,
    Cesium.CameraEventType.MIDDLE_DRAG,
    Cesium.CameraEventType.PINCH,
    { eventType: Cesium.CameraEventType.LEFT_DRAG, modifier: Cesium.KeyboardEventModifier.CTRL },
  ]
  scc.zoomEventTypes = [Cesium.CameraEventType.WHEEL, Cesium.CameraEventType.PINCH]

  // Background/embedded contexts can suspend requestAnimationFrame, which freezes
  // Cesium's render loop (and with it imagery/tile streaming). Watchdog: if no
  // frame has rendered since the last tick, drive a frame manually and pump the
  // request scheduler. When rAF runs normally this no-ops. Matters for wall
  // displays, embedded panes, and backgrounded tabs.
  // frameState/RequestScheduler.update are runtime APIs missing from the typings.
  const frameNumber = () =>
    (viewer.scene as unknown as { frameState: { frameNumber: number } }).frameState.frameNumber
  const pumpScheduler = () =>
    (Cesium.RequestScheduler as unknown as { update?: () => void }).update?.()

  let lastFrame = -1
  const keepAlive = setInterval(() => {
    if (viewer.isDestroyed()) {
      clearInterval(keepAlive)
      return
    }
    if (frameNumber() === lastFrame) {
      try {
        viewer.render()
        pumpScheduler()
      } catch (err) {
        console.error('[providers] watchdog render tick failed:', err)
      }
    }
    lastFrame = frameNumber()
  }, 400)

  let buildingTileset: Cesium.Cesium3DTileset | undefined

  if (mode === 'ion') {
    try {
      viewer.terrainProvider = await Cesium.createWorldTerrainAsync()
      const osmBuildings = await Cesium.createOsmBuildingsAsync()
      osmBuildings.cacheBytes = TILE_CACHE_BYTES // match the restore path in isolate's boost
      scene.primitives.add(osmBuildings)
      buildingTileset = osmBuildings
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
      // Stream tiles for the destination DURING camera flights — the address
      // fly-in arrives with imagery already sharpening instead of all-blur.
      tileset.preloadFlightDestinations = true
      // Keep requesting tiles WHILE the camera pans/orbits (default culls them
      // above a speed threshold) — otherwise every gesture ends in a blur that
      // only then starts loading. These are immutable CDN tiles; cheap.
      tileset.cullRequestsWhileMoving = false
      tileset.cacheBytes = TILE_CACHE_BYTES
      scene.primitives.add(tileset)
      buildingTileset = tileset
      // CRITICAL: hide the ellipsoid globe. Photorealistic streets sit BELOW
      // ellipsoid zero (geoid offset), so the invisible globe surface above
      // them is what CLAMP_TO_GROUND and sampleHeight hit first — the root
      // cause of "floating" hydrants/units at oblique angles. The tileset
      // covers the earth; nothing is lost. (ISOLATE re-shows it for the
      // flattened-map ground and hides it again on exit.)
      scene.globe.show = false
    } catch (err) {
      console.error('[providers] Google 3D Tiles failed, staying keyless:', err)
      return { viewer, mode: 'keyless', extrudeFootprints: true }
    }
  }

  // More parallel tile/data requests — Cesium's defaults leave bandwidth idle
  // and the blur lingers. These hosts serve immutable tiles; hammering is fine.
  Cesium.RequestScheduler.maximumRequestsPerServer = 18
  Cesium.RequestScheduler.requestsByServer['tile.googleapis.com:443'] = 18
  Cesium.RequestScheduler.requestsByServer['tile.openstreetmap.org:443'] = 12

  // Camera stays inside the ops envelope, and zoom is bounded so the operator
  // can neither fly to space nor clip through streets. 200 km still frames the
  // whole NYC+50mi rectangle in one view.
  const controller = scene.screenSpaceCameraController
  controller.minimumZoomDistance = 40
  controller.maximumZoomDistance = 200_000
  viewer.camera.moveEnd.addEventListener(() => {
    const pos = viewer.camera.positionCartographic
    const lat = Cesium.Math.toDegrees(pos.latitude)
    const lon = Cesium.Math.toDegrees(pos.longitude)
    const west = Cesium.Math.toDegrees(OPS_AREA.west)
    const east = Cesium.Math.toDegrees(OPS_AREA.east)
    const south = Cesium.Math.toDegrees(OPS_AREA.south)
    const north = Cesium.Math.toDegrees(OPS_AREA.north)
    const clampedLat = Math.min(Math.max(lat, south), north)
    const clampedLon = Math.min(Math.max(lon, west), east)
    if (clampedLat !== lat || clampedLon !== lon) {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(clampedLon, clampedLat, Math.min(pos.height, 200_000)),
        orientation: {
          heading: viewer.camera.heading,
          pitch: viewer.camera.pitch,
          roll: 0,
        },
        duration: 0.8,
      })
    }
  })

  // Hard floor: the camera must never slip beneath the map while orbiting or
  // scrolling. The floor tracks whatever surface IS the map right now — the
  // flat globe when it's shown (keyless / isolate ground), else the sunken
  // photorealistic streets (~-30 m geoid). Ground view is exempt: it manages
  // its own street-level camera with collision deliberately off.
  scene.preRender.addEventListener(() => {
    if (getAppState().groundViewActive) return
    // Camera FLIGHTS manage their own path (the ground-view exit climbs from
    // street level — a clamp's setView would cancel it and strand the camera).
    // User gestures are not tweens, so scroll/drag stays clamped.
    if ((scene as unknown as { tweens: { length: number } }).tweens.length > 0) return
    const floor = scene.globe.show ? 2 : -26
    const pos = viewer.camera.positionCartographic
    if (pos.height < floor) {
      viewer.camera.setView({
        destination: Cesium.Cartesian3.fromRadians(pos.longitude, pos.latitude, floor),
        orientation: { heading: viewer.camera.heading, pitch: viewer.camera.pitch, roll: viewer.camera.roll },
      })
    }
  })

  // Establishing shot: over the harbor looking north at Lower Manhattan.
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(-74.0085, 40.6875, 2800),
    orientation: { heading: 0, pitch: Cesium.Math.toRadians(-35), roll: 0 },
  })

  return { viewer, mode, extrudeFootprints: mode === 'keyless', buildingTileset }
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
