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
  const font = `600 ${PAINT_FONT_PX}px 'Inter', -apple-system, sans-serif`
  const canvas = document.createElement('canvas')
  const measure = canvas.getContext('2d')!
  measure.font = font
  canvas.width = Math.ceil(measure.measureText(text).width) + 40
  canvas.height = PAINT_CANVAS_H
  const ctx = canvas.getContext('2d')!
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 11
  ctx.strokeStyle = TEXT_HALO
  ctx.strokeText(text, canvas.width / 2, PAINT_CANVAS_H / 2 + 2)
  ctx.fillStyle = TEXT_FILL
  ctx.fillText(text, canvas.width / 2, PAINT_CANVAS_H / 2 + 2)
  paintCache.set(text, canvas)
  lruTouch(paintCache, text, 200)
  return canvas
}

/** One street name draped on the ground, oriented along the street. */
function buildPaintPrimitive(s: StreetLabel): Cesium.GroundPrimitive {
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
  return new Cesium.GroundPrimitive({
    geometryInstances: new Cesium.GeometryInstance({
      geometry: new Cesium.RectangleGeometry({
        rectangle: rect,
        rotation,
        // Texture rotates WITH the quad — text runs along the street.
        stRotation: rotation,
        vertexFormat: Cesium.MaterialAppearance.MaterialSupport.TEXTURED.vertexFormat,
      }),
    }),
    appearance: new Cesium.MaterialAppearance({
      material: Cesium.Material.fromType('Image', { image: canvas }),
      materialSupport: Cesium.MaterialAppearance.MaterialSupport.TEXTURED,
      translucent: true, // canvas alpha — only the glyphs paint
    }),
    // Drape onto whichever surface is under the camera: photorealistic
    // tiles in google mode, the globe in keyless.
    classificationType: Cesium.ClassificationType.BOTH,
    asynchronous: true,
  })
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
  prim: Cesium.GroundPrimitive
  lat: number
  lon: number
  rotation: number
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

  /** Remove + destroy — GroundPrimitive does not own its appearance material. */
  private removePrim(entry: PaintedLabel): void {
    const mat = entry.prim.appearance?.material as Cesium.Material | undefined
    this.viewer.scene.groundPrimitives.remove(entry.prim)
    if (mat && !mat.isDestroyed()) mat.destroy()
  }

  /**
   * Diff-based update keyed by STREET NAME (the fetch dedupes to one label
   * per name): paint already on the ground stays put unless its anchor
   * genuinely moved — the longest-segment anchor jitters between overlapping
   * camera-follow fetches, and rebuilding on jitter churned primitives on
   * every pan settle.
   */
  set(labels: StreetLabel[]): void {
    const next = new Set<string>()
    for (const s of labels.slice(0, MAX_LABELS)) {
      next.add(s.name)
      const existing = this.byName.get(s.name)
      if (existing) {
        const cosLat = Math.cos((s.lat * Math.PI) / 180)
        const movedM = Math.hypot((s.lat - existing.lat) * 111_320, (s.lon - existing.lon) * 111_320 * cosLat)
        if (movedM < REANCHOR_M && Math.abs(paintRotation(s) - existing.rotation) < REROTATE_RAD) continue
        this.removePrim(existing)
        this.byName.delete(s.name)
      }
      const prim = buildPaintPrimitive(s)
      prim.show = this.visible
      this.byName.set(s.name, { prim, lat: s.lat, lon: s.lon, rotation: paintRotation(s) })
      this.viewer.scene.groundPrimitives.add(prim)
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
