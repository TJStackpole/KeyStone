import * as Cesium from 'cesium'
import type { StreetLabel } from '../api/nyc'

/**
 * Street-name captions (NYC Street Centerline data) — painted ONTO the
 * street surface as ground-draped text quads, like the printed names on a
 * paper map. World-fixed: they foreshorten with the ground in 3D, never
 * re-aim with the camera, and never jump. Refreshes DIFF against what's
 * already drawn, so panning only adds/removes labels at the edges instead
 * of flickering the whole set.
 */

const TEXT_FILL = '#cbdaea'
const TEXT_HALO = 'rgba(6, 10, 16, 0.92)'

const imageCache = new Map<string, HTMLCanvasElement>()

// Both text caches grow forever as the camera roams the city — LRU-cap them.
// Eviction is safe: built billboards/primitives hold their own texture
// copies, and regeneration is a cheap one-off canvas draw.
function lruTouch(cache: Map<string, HTMLCanvasElement>, key: string, cap: number): void {
  const hit = cache.get(key)
  if (hit) {
    cache.delete(key)
    cache.set(key, hit)
  }
  while (cache.size > cap) cache.delete(cache.keys().next().value!)
}

/**
 * Crisp text-as-image for billboards: drawn at 2x and rendered at scale 0.5,
 * so it stays sharp on retina displays where Cesium's glyph labels go soft.
 * Shared by street captions and firehouse/marker labels.
 */
export function crispTextImage(text: string, fill = TEXT_FILL, sizePx = 22): HTMLCanvasElement {
  const key = `${fill}|${sizePx}|${text}`
  const cached = imageCache.get(key)
  if (cached) {
    lruTouch(imageCache, key, 300)
    return cached
  }
  const font = `600 ${sizePx}px 'JetBrains Mono', monospace` // 2x, downscaled for crispness
  const canvas = document.createElement('canvas')
  const measure = canvas.getContext('2d')!
  measure.font = font
  canvas.width = Math.ceil(measure.measureText(text).width) + 18
  canvas.height = Math.ceil(sizePx * 1.5)
  const ctx = canvas.getContext('2d')!
  ctx.font = font
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 6
  ctx.strokeStyle = TEXT_HALO
  ctx.strokeText(text, 9, canvas.height / 2 + 1)
  ctx.fillStyle = fill
  ctx.fillText(text, 9, canvas.height / 2 + 1)
  imageCache.set(key, canvas)
  lruTouch(imageCache, key, 300)
  return canvas
}

/** Rotation (radians CCW from the east-west axis) for a street bearing, kept
 *  in (-90, 90] so painted text never reads upside down. */
function rotationFor(bearingDeg: number): number {
  let theta = 90 - bearingDeg
  while (theta > 90) theta -= 180
  while (theta <= -90) theta += 180
  return Cesium.Math.toRadians(theta)
}

// High-res paint texture: rendered ~64 px tall, draped at ~7 m text height.
const PAINT_FONT_PX = 64
const PAINT_CANVAS_H = 96
const TEXT_HEIGHT_M = 7
const MAX_LABELS = 60

const paintCache = new Map<string, HTMLCanvasElement>()

function streetPaintCanvas(name: string): HTMLCanvasElement {
  const text = name.toUpperCase()
  const cached = paintCache.get(text)
  if (cached) {
    lruTouch(paintCache, text, 200)
    return cached
  }
  const font = `700 ${PAINT_FONT_PX}px 'Inter', -apple-system, sans-serif`
  const canvas = document.createElement('canvas')
  const measure = canvas.getContext('2d')!
  measure.font = font
  canvas.width = Math.ceil(measure.measureText(text).width) + 44
  canvas.height = PAINT_CANVAS_H
  const ctx = canvas.getContext('2d')!
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  // Heavy halo: the name must stay legible over the bright yellow road
  // overlay and busy rooftop imagery alike.
  ctx.lineWidth = 14
  ctx.strokeStyle = TEXT_HALO
  ctx.strokeText(text, canvas.width / 2, PAINT_CANVAS_H / 2 + 2)
  ctx.fillStyle = '#eef4fb'
  ctx.fillText(text, canvas.width / 2, PAINT_CANVAS_H / 2 + 2)
  paintCache.set(text, canvas)
  lruTouch(paintCache, text, 200)
  return canvas
}

/**
 * One street name as a world-fixed quad floating just above the asphalt,
 * oriented along the street, rendered with DEPTH TEST OFF. Draping the text
 * onto the surface (the previous approach) molded it over tree canopies and
 * fought the yellow road overlay in the same classification pass — this way
 * the name stays put like paint but ALWAYS reads on top of roads, trees, and
 * imagery, Google-Maps style.
 */
function buildPaintPrimitive(
  s: StreetLabel,
  viewer: Cesium.Viewer,
): { prim: Cesium.Primitive; heightOk: boolean } {
  const canvas = streetPaintCanvas(s.name)
  // World size from the canvas aspect at a fixed text height.
  const heightM = TEXT_HEIGHT_M * (PAINT_CANVAS_H / PAINT_FONT_PX)
  const lengthM = Math.min(200, heightM * (canvas.width / canvas.height))
  const latM = 111_320
  const lonM = 111_320 * Math.cos((s.lat * Math.PI) / 180)
  const rect = Cesium.Rectangle.fromDegrees(
    s.lon - lengthM / 2 / lonM,
    s.lat - heightM / 2 / latM,
    s.lon + lengthM / 2 / lonM,
    s.lat + heightM / 2 / latM,
  )
  const rotation = paintRotation(s)
  // Street height under the anchor from whatever geometry has streamed in
  // (google-mode streets sit ~-30 m; keyless globe at 0). With depth test
  // off the height only anchors the quad's parallax at tilt, so a coarse
  // sample is fine — a missing one falls back to 0 and retries next set().
  let sampled: number | undefined
  if (viewer.scene.sampleHeightSupported) {
    try {
      sampled = viewer.scene.sampleHeight(Cesium.Cartographic.fromDegrees(s.lon, s.lat))
    } catch {
      sampled = undefined
    }
  } else {
    sampled = 0 // keyless ellipsoid ground IS 0 — no retry needed
  }
  const prim = new Cesium.Primitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.RectangleGeometry({
        rectangle: rect,
        rotation,
        // Texture rotates WITH the quad — text runs along the street.
        stRotation: rotation,
        height: (sampled ?? 0) + 0.8,
        vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
      }),
    }),
    appearance: new Cesium.MaterialAppearance({
      material: Cesium.Material.fromType('Image', { image: canvas }),
      materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
      translucent: true, // canvas alpha — only the glyphs paint
      renderState: {
        // Never occluded, never molded over tree/roof geometry.
        depthTest: { enabled: false },
        depthMask: false,
        blending: Cesium.BlendingState.ALPHA_BLEND,
      },
    }),
    asynchronous: true,
    allowPicking: false,
  })
  return { prim, heightOk: sampled !== undefined }
}

/**
 * Cesium rotates RectangleGeometry in PLATE-CARRÉE degree space (lon/lat map
 * linearly, no cos-lat) — feeding it the true GROUND bearing skews labels
 * ~6-8° off their streets at NYC's latitude, visibly bleeding long names
 * onto buildings. Convert the ground angle to projection space first.
 */
function paintRotation(s: StreetLabel): number {
  const thetaGround = rotationFor(s.bearingDeg)
  const cosLat = Math.cos((s.lat * Math.PI) / 180)
  return Math.atan2(Math.sin(thetaGround) * cosLat, Math.cos(thetaGround))
}

interface PaintedLabel {
  prim: Cesium.Primitive
  lat: number
  lon: number
  rotation: number
  /** False = built before ground geometry streamed in; rebuild next set(). */
  heightOk: boolean
}

/** Anchor drift below this keeps the existing paint (fetch-jitter, not a move). */
const REANCHOR_M = 100
const REROTATE_RAD = Cesium.Math.toRadians(3)

export class StreetLabelLayer {
  private viewer: Cesium.Viewer
  private byName = new Map<string, PaintedLabel>()
  private visible = true

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer
  }

  /** Remove + destroy — the primitive does not own its appearance material. */
  private removePrim(entry: PaintedLabel): void {
    const mat = entry.prim.appearance?.material as Cesium.Material | undefined
    this.viewer.scene.primitives.remove(entry.prim)
    if (mat && !mat.isDestroyed()) mat.destroy()
  }

  /**
   * Diff-based update keyed by STREET NAME (the fetch dedupes to one label
   * per name): paint already placed stays put unless its anchor genuinely
   * moved — the longest-segment anchor jitters between overlapping
   * camera-follow fetches, and rebuilding on jitter churned primitives on
   * every pan settle. Labels built before ground geometry streamed in
   * (heightOk false) rebuild once a real street height is available.
   */
  set(labels: StreetLabel[]): void {
    const next = new Set<string>()
    for (const s of labels.slice(0, MAX_LABELS)) {
      next.add(s.name)
      const existing = this.byName.get(s.name)
      if (existing) {
        const cosLat = Math.cos((s.lat * Math.PI) / 180)
        const movedM = Math.hypot((s.lat - existing.lat) * 111_320, (s.lon - existing.lon) * 111_320 * cosLat)
        if (
          existing.heightOk &&
          movedM < REANCHOR_M &&
          Math.abs(paintRotation(s) - existing.rotation) < REROTATE_RAD
        ) {
          continue
        }
        this.removePrim(existing)
        this.byName.delete(s.name)
      }
      const { prim, heightOk } = buildPaintPrimitive(s, this.viewer)
      prim.show = this.visible
      this.byName.set(s.name, { prim, lat: s.lat, lon: s.lon, rotation: paintRotation(s), heightOk })
      this.viewer.scene.primitives.add(prim)
    }
    for (const [name, entry] of this.byName) {
      if (!next.has(name)) {
        this.removePrim(entry)
        this.byName.delete(name)
      }
    }
  }

  setVisible(show: boolean): void {
    this.visible = show
    for (const entry of this.byName.values()) entry.prim.show = show
  }

  clear(): void {
    for (const entry of this.byName.values()) this.removePrim(entry)
    this.byName.clear()
  }
}
